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
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择要导入 CodeWalk 的源码项目文件夹'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
$dialog.Dispose()
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
