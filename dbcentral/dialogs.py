"""Native Open/Save file dialogs, invoked by the local server on behalf of the UI."""
import os
import threading

_lock = threading.Lock()
_approved = set()   # paths the user picked in a dialog during this run (file read/write is limited to these)


def approve(path):
    if path:
        _approved.add(os.path.normcase(os.path.abspath(path)))


def is_approved(path):
    return os.path.normcase(os.path.abspath(path)) in _approved


def _filter_string(filters):
    filters = filters or [["All Files", "*.*"]]
    return "".join(f"{name} ({pat})\0{pat}\0" for name, pat in filters) + "\0"


def _win_dialog(save, title, filters, default_name, default_ext, initial_dir):
    import ctypes
    from ctypes import wintypes as wt

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wt.DWORD), ("hwndOwner", wt.HWND), ("hInstance", wt.HINSTANCE),
            ("lpstrFilter", wt.LPCWSTR), ("lpstrCustomFilter", wt.LPWSTR), ("nMaxCustFilter", wt.DWORD),
            ("nFilterIndex", wt.DWORD), ("lpstrFile", wt.LPWSTR), ("nMaxFile", wt.DWORD),
            ("lpstrFileTitle", wt.LPWSTR), ("nMaxFileTitle", wt.DWORD), ("lpstrInitialDir", wt.LPCWSTR),
            ("lpstrTitle", wt.LPCWSTR), ("Flags", wt.DWORD), ("nFileOffset", wt.WORD),
            ("nFileExtension", wt.WORD), ("lpstrDefExt", wt.LPCWSTR), ("lCustData", wt.LPARAM),
            ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wt.LPCWSTR), ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wt.DWORD), ("FlagsEx", wt.DWORD),
        ]

    ctypes.windll.ole32.CoInitializeEx(None, 2)
    buf = ctypes.create_unicode_buffer(default_name or "", 4096)
    filt = ctypes.create_unicode_buffer(_filter_string(filters))
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    ofn.hwndOwner = ctypes.windll.user32.GetForegroundWindow()
    ofn.lpstrFilter = ctypes.cast(filt, wt.LPCWSTR)
    ofn.nFilterIndex = 1
    ofn.lpstrFile = ctypes.cast(buf, wt.LPWSTR)
    ofn.nMaxFile = 4096
    ofn.lpstrTitle = title
    if initial_dir and os.path.isdir(initial_dir):
        ofn.lpstrInitialDir = initial_dir
    if default_ext:
        ofn.lpstrDefExt = default_ext.lstrip(".")
    OFN_OVERWRITEPROMPT, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST = 0x2, 0x8, 0x800
    OFN_FILEMUSTEXIST, OFN_EXPLORER, OFN_ENABLESIZING = 0x1000, 0x80000, 0x800000
    flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | OFN_ENABLESIZING
    if save:
        ok = ctypes.windll.comdlg32.GetSaveFileNameW
        flags |= OFN_OVERWRITEPROMPT
    else:
        ok = ctypes.windll.comdlg32.GetOpenFileNameW
        flags |= OFN_FILEMUSTEXIST
    ofn.Flags = flags
    if ok(ctypes.byref(ofn)):
        return buf.value
    return None


def _tk_dialog(save, title, filters, default_name, default_ext, initial_dir):
    import tkinter
    from tkinter import filedialog
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    ft = [(n, p.replace(";", " ")) for n, p in (filters or [["All Files", "*.*"]])]
    try:
        if save:
            path = filedialog.asksaveasfilename(parent=root, title=title, filetypes=ft,
                                                initialfile=default_name or "", defaultextension=default_ext or "",
                                                initialdir=initial_dir or None)
        else:
            path = filedialog.askopenfilename(parent=root, title=title, filetypes=ft, initialdir=initial_dir or None)
    finally:
        root.destroy()
    return path or None


def file_dialog(save=False, title=None, filters=None, default_name=None, default_ext=None, initial_dir=None):
    title = title or ("Save File" if save else "Open File")
    with _lock:
        if os.name == "nt":
            try:
                path = _win_dialog(save, title, filters, default_name, default_ext, initial_dir)
            except Exception:  # noqa: BLE001 - fall back to Tk
                path = _tk_dialog(save, title, filters, default_name, default_ext, initial_dir)
        else:
            path = _tk_dialog(save, title, filters, default_name, default_ext, initial_dir)
    if path:
        path = os.path.abspath(path)
        approve(path)
    return path
