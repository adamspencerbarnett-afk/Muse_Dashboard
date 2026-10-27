// Muse Dashboard · lib/folder-dialog.js
// Author: Adam S. Barnett
//
// Native "Select folder" dialog (Windows only). A web page cannot learn a real
// folder path from the browser's own pickers, but the dashboard runs on the
// same PC, so it shows the Explorer folder dialog (IFileOpenDialog with
// FOS_PICKFOLDERS) from a short-lived PowerShell process and hands the chosen
// path back to the page. Other systems use the in-page folder browser.
import { spawn } from "node:child_process";
import { httpError } from "./util.js";

// The owner form is invisible and topmost so the dialog opens in front of the
// browser instead of behind it. The start folder arrives in an environment
// variable (never spliced into the script); the result is base64 UTF-8 so
// non-ASCII paths survive the console code page.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MuseFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);
  public static string Pick(IntPtr owner, string title, string start) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts;
    dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("&Select Folder");
    if (!String.IsNullOrEmpty(start)) {
      try {
        Guid iid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        dlg.SetFolder(folder);
      } catch { }
    }
    if (dlg.Show(owner) != 0) return null; // cancelled
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.FormBorderStyle = 'None'
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
try {
  $picked = [MuseFolderDialog]::Pick($owner.Handle, $env:MUSE_PICK_TITLE, $env:MUSE_PICK_START)
} finally {
  $owner.Close()
}
if ($picked) { [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picked))) } else { [Console]::Out.Write('CANCEL') }
`;
const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");

let open = null;

/**
 * Show the Windows folder dialog. Resolves to the chosen absolute path, or
 * null when the user cancels. One dialog at a time; it closes itself after
 * `timeoutMs` so a forgotten dialog does not hold the request forever.
 */
export function pickFolderNative({ title = "Select a project folder", start = "", timeoutMs = 10 * 60 * 1000 } = {}) {
  if (process.platform !== "win32") return Promise.reject(httpError(501, "The system folder dialog is only available on Windows."));
  if (open) return Promise.reject(httpError(409, "A folder dialog is already open. Finish or cancel it first."));
  open = new Promise((resolve, reject) => {
    // No windowsHide: the dialog must be allowed to show. The child shares the
    // dashboard's console, so no extra console window appears.
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MUSE_PICK_TITLE: String(title), MUSE_PICK_START: String(start || "") },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(httpError(500, `Could not open the folder dialog: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (text.startsWith("OK:")) return resolve(Buffer.from(text.slice(3), "base64").toString("utf8"));
      if (text === "CANCEL") return resolve(null);
      const detail = err.replace(/#< CLIXML[\s\S]*$/, "").trim().split(/\r?\n/)[0] || `exit code ${code}`;
      reject(httpError(500, `The folder dialog failed: ${detail}`));
    });
  });
  return open.finally(() => { open = null; });
}
