import { spawn } from 'node:child_process';

function runPicker(command, args, { cancelCodes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) return resolve(stdout.trim() || null);
      if (cancelCodes.includes(code)) return resolve(null);
      reject(new Error(stderr.trim() || `目录选择器退出，代码 ${code}`));
    });
  });
}

async function pickOnWindows() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodeWalkFolderPicker
{
    [Flags]
    private enum FileOpenOptions : uint
    {
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        NoChangeDirectory = 0x00000008,
        PathMustExist = 0x00000800,
        DoNotAddToRecent = 0x02000000
    }

    private enum DisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filterSpec);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FileOpenOptions options);
        void GetOptions(out FileOpenOptions options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(DisplayName displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static string Pick()
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialog();
        try
        {
            dialog.SetOptions(
                FileOpenOptions.PickFolders |
                FileOpenOptions.ForceFileSystem |
                FileOpenOptions.NoChangeDirectory |
                FileOpenOptions.PathMustExist |
                FileOpenOptions.DoNotAddToRecent);
            dialog.SetTitle("选择要导入 CodeWalk 的源码项目文件夹");
            dialog.SetOkButtonLabel("选择项目");
            int result = dialog.Show(GetForegroundWindow());
            if (result == unchecked((int)0x800704C7)) return null;
            if (result < 0) Marshal.ThrowExceptionForHR(result);

            IShellItem item;
            dialog.GetResult(out item);
            try
            {
                IntPtr value;
                item.GetDisplayName(DisplayName.FileSystemPath, out value);
                try { return Marshal.PtrToStringUni(value); }
                finally { Marshal.FreeCoTaskMem(value); }
            }
            finally
            {
                Marshal.ReleaseComObject(item);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
$selected = [CodeWalkFolderPicker]::Pick()
if ($null -ne $selected) {
  [Console]::Out.Write($selected)
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runPicker('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded]);
}

function pickOnMac() {
  return runPicker('osascript', [
    '-e',
    'try',
    '-e',
    'POSIX path of (choose folder with prompt "选择要导入 CodeWalk 的源码项目文件夹")',
    '-e',
    'on error number -128',
    '-e',
    'return ""',
    '-e',
    'end try',
  ]);
}

async function pickOnLinux() {
  try {
    return await runPicker(
      'zenity',
      ['--file-selection', '--directory', '--title=选择要导入 CodeWalk 的源码项目文件夹'],
      { cancelCodes: [1] },
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return runPicker(
      'kdialog',
      ['--getexistingdirectory', '.', '--title', '选择要导入 CodeWalk 的源码项目文件夹'],
      { cancelCodes: [1] },
    );
  }
}

export async function pickProjectDirectory() {
  try {
    if (process.platform === 'win32') return await pickOnWindows();
    if (process.platform === 'darwin') return await pickOnMac();
    return await pickOnLinux();
  } catch (error) {
    throw new Error(`无法打开本地目录选择器：${error.message}`);
  }
}
