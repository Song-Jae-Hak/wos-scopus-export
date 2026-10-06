# Folder picker for the Work Assistant server (lib/local-files.js -> pickFolder).
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI codepage.
# Korean text (dialog title, initial path) comes in through environment variables instead.
#
#   WA_DESC     dialog title
#   WA_INITIAL  folder to open first (optional)
#   stdout      chosen folder path (UTF-8), empty when cancelled
#
# Why the extra owner window: the server runs in the background, and Windows does not let a
# background process bring a new window to the front, so a plain dialog opens hidden behind the
# browser. A tiny transparent TopMost owner window keeps the dialog on top of everything.

[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ModernFolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialogRCW { }

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
        void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_NOCHANGEDIR = 0x8;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    // returns the chosen path, "" when cancelled; throws when the modern dialog is unavailable
    public static string Pick(IntPtr owner, string title, string initial) {
        var dlg = (IFileDialog)new FileOpenDialogRCW();
        uint opts; dlg.GetOptions(out opts);
        dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR);
        if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
        if (!string.IsNullOrEmpty(initial) && System.IO.Directory.Exists(initial)) {
            try {
                IShellItem folder;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
                dlg.SetFolder(folder);
            } catch { }
        }
        int hr = dlg.Show(owner);
        if (hr == ERROR_CANCELLED) return "";
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        IShellItem result; dlg.GetResult(out result);
        string path; result.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return path;
    }
}
"@

# Tiny transparent TopMost owner at the screen center, so the dialog opens in front of the browser.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner.Location = New-Object System.Drawing.Point(([int]($area.X + $area.Width / 2)), ([int]($area.Y + $area.Height / 3)))
$owner.Show()
$owner.Activate()

$picked = ''
try {
    $picked = [ModernFolderPicker]::Pick($owner.Handle, $env:WA_DESC, $env:WA_INITIAL)
} catch {
    # Fallback: classic tree dialog (still owned by the TopMost window)
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = $env:WA_DESC
    $d.ShowNewFolderButton = $true
    if ($env:WA_INITIAL -and (Test-Path -LiteralPath $env:WA_INITIAL)) { $d.SelectedPath = $env:WA_INITIAL }
    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $d.SelectedPath }
}
$owner.Close()
$owner.Dispose()
if ($picked) { Write-Output $picked }
