; Windows 不允许覆盖正在运行的可执行文件。myterminal-cli 由 Codex、Claude 等外部 MCP 客户端托管，
; 即使 MyTerminal 主程序已经退出，它仍可能占用安装目录中的旧文件，因此必须在复制新文件前清理。
!macro NSIS_HOOK_PREINSTALL
  ; 安装器模板可能在后续步骤继续使用通用寄存器，钩子必须完整保留现场。
  Push $0
  Push $1

  ; 只终止可执行路径与当前安装目录完全一致的 CLI，避免误伤开发目录或其它 MyTerminal 安装实例。
  ; 随包附带的 x64\OpenConsole.exe（新版 ConPTY 宿主）若因主程序异常退出而残留，同样会锁住文件，按同一规则清理；
  ; 只匹配本安装目录下的路径，绝不影响 Windows Terminal 等其它程序自带的 OpenConsole。
  ; 目标路径通过进程级环境变量传给 PowerShell，避免安装路径含空格时发生参数拆分或命令注入。
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("MYTERMINAL_INSTALL_CLI_PATH", "$INSTDIR\myterminal-cli.exe")'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("MYTERMINAL_INSTALL_CONSOLE_PATH", "$INSTDIR\x64\OpenConsole.exe")'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$$targetPaths = @([System.IO.Path]::GetFullPath($$env:MYTERMINAL_INSTALL_CLI_PATH), [System.IO.Path]::GetFullPath($$env:MYTERMINAL_INSTALL_CONSOLE_PATH)); $$lockedProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter 'Name = ''myterminal-cli.exe'' OR Name = ''OpenConsole.exe''' | Where-Object { $$_.ExecutablePath -and ($$targetPaths -icontains [System.IO.Path]::GetFullPath($$_.ExecutablePath)) }); foreach ($$lockedProcess in $$lockedProcesses) { Stop-Process -Id $$lockedProcess.ProcessId -Force -ErrorAction Stop; Wait-Process -Id $$lockedProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }"`
  Pop $0
  Pop $1

  ; 清理失败时中止复制并给出可执行的处理方式，避免再次落入 NSIS 含糊的“文件无法写入”提示。
  StrCmp $0 "0" myterminal_cli_cleanup_succeeded
  MessageBox MB_ICONSTOP|MB_OK "无法关闭旧版 myterminal-cli.exe。请关闭正在使用 MyTerminal MCP 的 Codex、Claude 等客户端，然后重新运行安装程序。$\r$\n$\r$\n详细信息：$1"
  Abort

myterminal_cli_cleanup_succeeded:
  Pop $1
  Pop $0
!macroend
