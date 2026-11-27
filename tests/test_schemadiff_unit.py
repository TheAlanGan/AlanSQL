"""Schema compare logic on fixed SHOW CREATE TABLE text (no server needed)."""
import pytest

from dbcentral import schemadiff
from dbcentral.schemadiff import Ctx, Snapshot, diff_table, diff_view, parse_table


def q(name):
    return "`" + name.replace("`", "``") + "`"


def ctx(**opts):
    src, tgt = Snapshot("src"), Snapshot("tgt")
    tgt.is_mariadb = True
    return Ctx(src, tgt, opts, q)


ORDERS = """CREATE TABLE `orders` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `customer_id` int(11) DEFAULT NULL,
  `total` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_x` (`total`),
  KEY `idx_cust` (`customer_id`),
  FULLTEXT KEY `ft` (`note`),
  CONSTRAINT `fk_c` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_total` CHECK (`total` >= 0)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='It''s orders'"""


def test_parse_table():
    t = parse_table(ORDERS)
    assert t["columns"] == ["id", "customer_id", "total"]
    assert set(t["indexes"]) == {"PRIMARY", "uq_x", "idx_cust", "ft"}
    assert list(t["fks"]) == ["fk_c"] and list(t["checks"]) == ["chk_total"]
    assert t["options"]["ENGINE"] == "InnoDB" and "AUTO_INCREMENT" not in t["options"]
    assert t["options"]["COMMENT"] == "'It''s orders'"


def statements(item):
    return "\n".join(s[1] for s in item["statements"])


def test_identical_tables_except_auto_increment():
    other = ORDERS.replace("AUTO_INCREMENT=42", "AUTO_INCREMENT=7")
    assert diff_table(ctx(), "orders", ORDERS, other)["status"] == "same"


def test_new_and_dropped_tables():
    new = diff_table(ctx(), "orders", ORDERS, None)
    sql = statements(new)
    assert new["status"] == "create" and sql.startswith("CREATE TABLE `tgt`.`orders`")
    assert "AUTO_INCREMENT=42" not in sql and "REFERENCES `tgt`.`customers`" in sql
    gone = diff_table(ctx(), "orders", None, ORDERS)
    assert gone["status"] == "drop" and gone["destructive"] and statements(gone) == "DROP TABLE `tgt`.`orders`"


def test_column_changes_keep_order_and_flag_drops():
    src = "CREATE TABLE `t` (\n  `id` int(11) NOT NULL,\n  `name` varchar(100) NOT NULL,\n  `email` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"
    tgt = "CREATE TABLE `t` (\n  `id` int(11) NOT NULL,\n  `email` varchar(100) DEFAULT NULL,\n  `name` varchar(50) NOT NULL,\n  `legacy` tinyint(4) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"
    item = diff_table(ctx(), "t", src, tgt)
    sql = statements(item)
    assert item["status"] == "alter" and item["destructive"]
    assert "DROP COLUMN `legacy`" in sql
    assert "MODIFY COLUMN `name` varchar(100) NOT NULL AFTER `id`" in sql
    assert "MODIFY COLUMN `email` varchar(255) DEFAULT NULL AFTER `name`" in sql


def test_ignore_column_order():
    src = "CREATE TABLE `t` (\n  `a` int(11),\n  `b` int(11)\n) ENGINE=InnoDB"
    tgt = "CREATE TABLE `t` (\n  `b` int(11),\n  `a` int(11)\n) ENGINE=InnoDB"
    assert diff_table(ctx(), "t", src, tgt)["status"] == "alter"
    assert diff_table(ctx(ignore_column_order=True), "t", src, tgt)["status"] == "same"


def test_int_display_width_is_ignored_by_default():
    src = "CREATE TABLE `t` (\n  `a` int(11) NOT NULL\n) ENGINE=InnoDB"
    tgt = "CREATE TABLE `t` (\n  `a` int NOT NULL\n) ENGINE=InnoDB"
    assert diff_table(ctx(), "t", src, tgt)["status"] == "same"
    assert diff_table(ctx(ignore_int_width=False), "t", src, tgt)["status"] == "alter"


def test_foreign_keys_are_dropped_first_and_added_last():
    tgt = ORDERS.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")
    item = diff_table(ctx(), "orders", ORDERS, tgt)
    phases = {p: sql for p, sql in item["statements"]}
    assert "DROP FOREIGN KEY `fk_c`" in phases[schemadiff.P_DROP_FK]
    assert "ADD CONSTRAINT `fk_c`" in phases[schemadiff.P_ADD_FK] and "ON DELETE CASCADE" in phases[schemadiff.P_ADD_FK]
    assert schemadiff.P_DROP_FK < schemadiff.P_ALTER_TABLE < schemadiff.P_ADD_FK


def test_check_constraint_drop_syntax_depends_on_server():
    tgt = ORDERS.replace("`total` >= 0", "`total` > 0")
    c = ctx()
    assert "DROP CONSTRAINT `chk_total`" in statements(diff_table(c, "orders", ORDERS, tgt))
    c.mariadb_target = False
    assert "DROP CHECK `chk_total`" in statements(diff_table(c, "orders", ORDERS, tgt))


def test_table_option_changes():
    tgt = ORDERS.replace("ENGINE=InnoDB", "ENGINE=MyISAM").replace(" COMMENT='It''s orders'", "")
    sql = statements(diff_table(ctx(), "orders", ORDERS, tgt))
    assert "ENGINE=InnoDB" in sql and "COMMENT='It''s orders'" in sql


def test_views_are_retargeted_and_compared_without_schema_names():
    v_src = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select `src`.`t`.`a` AS `a` from `src`.`t`"
    v_tgt = v_src.replace("`src`.", "`tgt`.").replace("`root`@`localhost`", "`app`@`%`")
    assert diff_view(ctx(), "v", v_src, v_tgt)["status"] == "same"            # schema and DEFINER ignored
    item = diff_view(ctx(), "v", v_src, None)
    sql = statements(item)
    assert sql.startswith("CREATE OR REPLACE") and "VIEW `tgt`.`v` AS" in sql
    assert "`src`." not in sql and "DEFINER=" not in sql


@pytest.mark.parametrize("keep", [False, True])
def test_keep_definer_option(keep):
    v = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `x`"
    sql = statements(diff_view(ctx(keep_definer=keep), "v", v, None))
    assert ("DEFINER=`root`@`localhost`" in sql) is keep
