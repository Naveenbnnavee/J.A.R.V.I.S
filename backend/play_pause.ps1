$code = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);'
$kb = Add-Type -MemberDefinition $code -Name 'KB' -Namespace 'Win32' -PassThru
$kb::keybd_event(179, 0, 0, 0)
$kb::keybd_event(179, 0, 2, 0)
