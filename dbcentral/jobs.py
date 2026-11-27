"""Tiny background job registry (exports, imports)."""
import threading
import time
import traceback
import uuid

_JOBS = {}
_lock = threading.Lock()


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, kind, title):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.title = title
        self.status = "running"
        self.progress = 0.0
        self.message = "Starting..."
        self.log = []
        self.result = None
        self.error = None
        self.cancel_requested = False
        self.started = time.time()
        self.finished = None

    def update(self, progress=None, message=None):
        if self.cancel_requested:
            raise JobCancelled()
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message

    def add_log(self, line):
        self.log.append(line)
        if len(self.log) > 500:
            del self.log[:100]

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
                "progress": self.progress, "message": self.message, "log": self.log[-200:],
                "result": self.result, "error": self.error, "started": self.started, "finished": self.finished}


def start(kind, title, fn):
    job = Job(kind, title)
    with _lock:
        _JOBS[job.id] = job

    def run():
        try:
            job.result = fn(job)
            job.status = "done"
            job.progress = 1.0
        except JobCancelled:
            job.status = "cancelled"
            job.message = "Cancelled."
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.error = getattr(e, "message", None) or str(e) or e.__class__.__name__
            if not hasattr(e, "message"):      # expected database errors need no traceback
                job.add_log(traceback.format_exc(limit=3))
        finally:
            job.finished = time.time()

    threading.Thread(target=run, name=f"job-{job.id}", daemon=True).start()
    return job


def get(job_id):
    return _JOBS.get(job_id)
