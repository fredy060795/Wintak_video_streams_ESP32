# Helm Camera Streams - test on a Windows PC (started by start.bat)
#
# - checks Node.js (offers installation via winget), installs packages on first start
# - determines the PC's IP address on the network
# - creates its own HTTPS certificates (test CA, added to Windows)
# - starts the server on port 5036 and opens the admin window at https://<PC-IP>:5036/admin/
# - additionally writes everything to start.log
# Runs with Windows PowerShell 5.1 and PowerShell 7.

# Not 'Stop': Windows PowerShell 5.1 would otherwise abort on every warning from npm/node
$ErrorActionPreference = 'Continue'
# Node.js outputs UTF-8; otherwise Windows PowerShell 5.1 shows special characters wrong
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Port = 5036
$LogFile = Join-Path $Root 'start.log'

# show error output (stderr) of node/npm as normal text
function Clean($line) {
    if ($line -is [System.Management.Automation.ErrorRecord]) { $line = $line.Exception.Message }
    $line = [string]$line
    if ($line -eq 'System.Management.Automation.RemoteException') { return '' }
    return $line
}

function Say([string]$text, [string]$color = 'Gray') {
    Write-Host $text -ForegroundColor $color
    Add-Content -Path $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $text)
}

# IPv4 address of the network adapter with a default gateway (Wi-Fi/LAN), otherwise localhost
function Get-LanIp {
    try {
        $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
            $_.OperationalStatus -eq 'Up' -and
            $_.NetworkInterfaceType -ne 'Loopback' -and
            $_.Description -notmatch 'Virtual|VMware|Hyper-V|VirtualBox|vEthernet|Loopback|TAP|WSL'
        }
        foreach ($nic in $nics) {
            $props = $nic.GetIPProperties()
            $gw = $props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' }
            if (-not $gw) { continue }
            $ip = $props.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
            if ($ip) { return $ip.Address.ToString() }
        }
    } catch { }
    return 'localhost'
}

Set-Content -Path $LogFile -Value ('Start ' + (Get-Date)) -Encoding UTF8
Write-Host ''
Write-Host '  Helm Camera Streams - test on a PC' -ForegroundColor Cyan
Write-Host '  ================================' -ForegroundColor Cyan
Write-Host ''

# ---- Node.js ------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Say 'Node.js is not installed.' 'Yellow'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $answer = Read-Host 'Install Node.js now with winget? (y/n)'
        if ($answer -match '^[jJyY]') {
            winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            Say 'Node.js was installed. Please close this window and run start.bat again.' 'Green'
            exit 0
        }
    }
    Say 'Please install Node.js LTS from https://nodejs.org and run start.bat again.' 'Yellow'
    exit 1
}
$nodeVersion = (& node --version).Trim()
Say "Node.js $nodeVersion found."
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
    Say 'Node.js is too old (at least version 20 needed). Please install Node.js LTS from https://nodejs.org.' 'Red'
    exit 1
}

# ---- Packages (reinstall when package-lock.json changed) ------------------
$lockHash = (Get-FileHash (Join-Path $Root 'package-lock.json')).Hash
$marker = Join-Path $Root 'node_modules\.helm-installed'
$installed = ''
if (Test-Path $marker) { $installed = (Get-Content $marker -Raw).Trim() }
if ($installed -ne $lockHash) {
    Say 'Installing packages (needs internet) ...'
    & npm ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Say (Clean $_) }
    if ($LASTEXITCODE -ne 0) {
        Say 'Installation failed. Check the internet connection.' 'Red'
        exit 1
    }
    Set-Content -Path $marker -Value $lockHash
}

# ---- ffmpeg (optional) ------------------------------------------------------
$localFfmpeg = Join-Path $Root 'tools\ffmpeg\bin\ffmpeg.exe'
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Say 'ffmpeg found: HLS and MPEG-TS available.'
} elseif (Test-Path $localFfmpeg) {
    $env:FFMPEG_PATH = $localFfmpeg
    Say 'ffmpeg from tools\ffmpeg found: HLS and MPEG-TS available.'
} else {
    Say 'Note: ffmpeg not found - only the MJPEG link works.' 'Yellow'
    Say '         For HLS/MPEG-TS: "winget install Gyan.FFmpeg" or put ffmpeg into tools\ffmpeg\bin\.' 'Yellow'
}

# ---- Stop an old server on the port ------------------------------------------
function Stop-OldServer {
    try { $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { return }
    foreach ($c in $conns) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.Name -eq 'node.exe' -and $proc.CommandLine -match 'server\.js') {
            Say "Stopping old server on port $Port (PID $($proc.ProcessId))." 'Yellow'
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            Say "Port $Port is already used by '$($proc.Name)' (PID $($proc.ProcessId)). Please close that program." 'Red'
            exit 1
        }
    }
}
Stop-OldServer

# ---- Windows firewall: open the port for phones on the Wi-Fi --------------------
function Test-FirewallOk {
    try {
        if (-not (Get-NetFirewallRule -DisplayName "Helm Camera Streams (TCP $Port)" -ErrorAction SilentlyContinue)) { return $false }
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        $blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
            Where-Object { $_.Program -and ($_.Program -ieq $node -or [IO.Path]::GetFileName($_.Program) -ieq 'node.exe') } |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
        return -not $blocked
    } catch { return $true } # firewall cannot be queried: do nothing
}

function Enable-Firewall {
    if ($env:OS -ne 'Windows_NT') { return }
    if (Test-FirewallOk) { return }
    Say "Firewall: opening port $Port and Node.js for phones on the network." 'Yellow'
    Say "          Windows will ask for administrator rights - please choose 'Yes'." 'Yellow'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\firewall.ps1') -Port $Port | Out-Null
    if (Test-FirewallOk) {
        Say 'Firewall opened.' 'Green'
    } else {
        Say 'Firewall NOT opened - phones may not reach the PC.' 'Red'
        Say '  Fix: double-click firewall.bat and choose "Yes". Details are in firewall.log.' 'Red'
    }
}
Enable-Firewall

# ---- Address and own HTTPS certificates ---------------------------------------
$ip = Get-LanIp
$env:PORT = "$Port"
$env:DATA_DIR = Join-Path $Root 'data'
$certDir = Join-Path $env:DATA_DIR 'certs'
$caFile = $null
& node (Join-Path $Root 'tools\make-cert.js') $certDir $ip 2>&1 | ForEach-Object {
    $line = Clean $_
    if ($line -match 'ca\.crt$') { $caFile = $line } elseif ($line) { Say $line }
}

if ($caFile -and (Test-Path $caFile)) {
    $base = "https://${ip}:$Port"
    $env:TLS_CERT = Join-Path $certDir 'server.crt'
    $env:TLS_KEY = Join-Path $certDir 'server.key'
    $env:TEST_CA_FILE = $caFile

    # add the test CA to Windows as trusted once (Chrome/Edge use the Windows store)
    if ($env:OS -eq 'Windows_NT') {
        try {
            $ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caFile)
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
            $store.Open('ReadWrite')
            $known = $store.Certificates | Where-Object { $_.Thumbprint -eq $ca.Thumbprint }
            if (-not $known) {
                Say 'Windows will ask whether to install the test certificate: please choose "Yes".' 'Yellow'
                $store.Add($ca)
                Say 'Test certificate added to Windows. If the browser still warns: restart the browser.' 'Green'
            }
            $store.Close()
        } catch {
            Say 'Test certificate was not added - the browser will show a warning ("Advanced -> Proceed").' 'Yellow'
        }
    }
} else {
    Say 'Certificate could not be created - server runs without HTTPS (Bluetooth only via localhost).' 'Yellow'
    $base = "http://${ip}:$Port"
}
$env:PUBLIC_URL = $base

Write-Host ''
Say "Admin:   $base/admin/   (first login: admin / admin123)" 'Green'
Say "Data:    $($env:DATA_DIR)"
try {
    $others = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne $ip } |
        ForEach-Object { $_.Address.ToString() }
    if ($others) { Say ("Other addresses of this PC: " + ($others -join ', ') + "  (in case the phone cannot reach the one above)") }
} catch { }
Write-Host ''
Write-Host '  Phones on the same Wi-Fi reach the server at this address.'
Write-Host '  Page does not load on the phone: is it on the same Wi-Fi? (no guest Wi-Fi, no mobile data)'
Write-Host '  If Windows asks about the firewall, choose "Allow access" (private AND public).'
Write-Host '  iPhone: Bluetooth only works in the "Bluefy" app - the phone page shows the way.'
if ($env:TEST_CA_FILE) {
    Write-Host ''
    Write-Host '  Phones once: in the admin open "QR / Links" of a stream and scan the QR code'
    Write-Host '  "Certificate for the phone", download the file and install it as a CA certificate.'
    Write-Host "  (Direct: $base/ca.crt)"
}
Write-Host ''
Write-Host '  Keep this window open. Close it or press Ctrl+C to stop.' -ForegroundColor Cyan
Write-Host ''

# open the browser shortly after the server starts
if (-not $env:HELM_NO_BROWSER) {
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 2; Start-Process $u } -ArgumentList "$base/admin/" | Out-Null
}

& node (Join-Path $Root 'server.js') 2>&1 | ForEach-Object { Say (Clean $_) }
Say "Server stopped (code $LASTEXITCODE)." 'Yellow'
