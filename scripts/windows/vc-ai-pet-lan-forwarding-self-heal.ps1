[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$SimulatedWslIPv4,
    [string]$SimulatedWindowsLanIPv4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$OfficialLanIp = '192.168.1.175'
$OfficialLanPort = 17870
$DistroName = 'kali-linux'
$WindowsSystemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$WslExe = Join-Path $WindowsSystemRoot 'System32\wsl.exe'
$NetshExe = Join-Path $WindowsSystemRoot 'System32\netsh.exe'

function Write-Result {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [AllowEmptyString()]
        [string]$Value
    )

    Write-Output ('{0}={1}' -f $Name, $Value)
}

function Assert-IPv4 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw ('{0}_INVALID={1}' -f $Label, $Value)
    }

    return $parsed.ToString()
}

function Get-CurrentWslIPv4 {
    if (-not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4)) {
        return Assert-IPv4 -Value $SimulatedWslIPv4 -Label 'SIMULATED_WSL_IPV4'
    }

    if (-not (Test-Path -LiteralPath $WslExe)) {
        throw ('WSL_EXECUTABLE_NOT_FOUND={0}' -f $WslExe)
    }

    $lines = @(& $WslExe -d $DistroName -- ip -4 -o addr show dev eth0 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw ('WSL_IPV4_QUERY_FAILED=exit_{0}' -f $LASTEXITCODE)
    }

    foreach ($line in $lines) {
        $match = [regex]::Match([string]$line, '\binet\s+(?<address>\d{1,3}(?:\.\d{1,3}){3})/')
        if ($match.Success) {
            return Assert-IPv4 -Value $match.Groups['address'].Value -Label 'WSL_IPV4'
        }
    }

    throw 'WSL_IPV4_NOT_FOUND'
}

function Test-WindowsOwnsOfficialLanIp {
    if (-not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)) {
        $simulated = Assert-IPv4 -Value $SimulatedWindowsLanIPv4 -Label 'SIMULATED_WINDOWS_LAN_IPV4'
        return $simulated -eq $OfficialLanIp
    }

    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $OfficialLanIp -ErrorAction SilentlyContinue)
    return $addresses.Count -gt 0
}

function Get-PortProxyEntries {
    $lines = @(& $NetshExe interface portproxy show v4tov4 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('PORTPROXY_QUERY_FAILED=exit_{0}' -f $LASTEXITCODE)
    }

    $entries = @()
    foreach ($line in $lines) {
        $match = [regex]::Match([string]$line, '^\s*(?<listen>\d{1,3}(?:\.\d{1,3}){3})\s+(?<listenPort>\d+)\s+(?<connect>\d{1,3}(?:\.\d{1,3}){3})\s+(?<connectPort>\d+)\s*$')
        if ($match.Success) {
            $entries += [pscustomobject]@{
                ListenAddress = $match.Groups['listen'].Value
                ListenPort = [int]$match.Groups['listenPort'].Value
                ConnectAddress = $match.Groups['connect'].Value
                ConnectPort = [int]$match.Groups['connectPort'].Value
            }
        }
    }

    return $entries
}

function Update-OfficialPortProxy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WslIPv4,
        [Parameter(Mandatory = $true)]
        [object[]]$ExistingEntries
    )

    $isSimulation = $DryRun -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)
    if ($isSimulation) {
        Write-Result -Name 'PORTPROXY' -Value ('WOULD_UPDATE {0}:{1}->{2}:{1}' -f $OfficialLanIp, $OfficialLanPort, $WslIPv4)
        Write-Result -Name 'PORTPROXY_SCOPE' -Value 'TARGET_ONLY'
        return
    }

    $targetEntries = @(
        $ExistingEntries | Where-Object {
            $_.ListenAddress -eq $OfficialLanIp -and $_.ListenPort -eq $OfficialLanPort
        }
    )

    $deleteOutput = @(& $NetshExe interface portproxy delete v4tov4 listenaddress=$OfficialLanIp listenport=$OfficialLanPort 2>&1)
    $deleteExit = $LASTEXITCODE
    if ($targetEntries.Count -gt 0 -and $deleteExit -ne 0) {
        throw ('PORTPROXY_DELETE_FAILED=exit_{0} {1}' -f $deleteExit, ($deleteOutput -join ' '))
    }

    $addOutput = @(& $NetshExe interface portproxy add v4tov4 listenaddress=$OfficialLanIp listenport=$OfficialLanPort connectaddress=$WslIPv4 connectport=$OfficialLanPort 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('PORTPROXY_ADD_FAILED=exit_{0} {1}' -f $LASTEXITCODE, ($addOutput -join ' '))
    }

    Write-Result -Name 'PORTPROXY' -Value ('UPDATED {0}:{1}->{2}:{1}' -f $OfficialLanIp, $OfficialLanPort, $WslIPv4)
    Write-Result -Name 'PORTPROXY_SCOPE' -Value 'TARGET_ONLY'
}

function Assert-OfficialPortProxy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WslIPv4
    )

    $entries = @(Get-PortProxyEntries)
    $targetEntries = @(
        $entries | Where-Object {
            $_.ListenAddress -eq $OfficialLanIp -and $_.ListenPort -eq $OfficialLanPort
        }
    )

    if ($targetEntries.Count -ne 1) {
        throw ('PORTPROXY_TARGET_COUNT={0}' -f $targetEntries.Count)
    }

    $target = $targetEntries[0]
    if ($target.ConnectAddress -ne $WslIPv4 -or $target.ConnectPort -ne $OfficialLanPort) {
        throw ('PORTPROXY_TARGET_MISMATCH={0}:{1}->{2}:{3}' -f $target.ListenAddress, $target.ListenPort, $target.ConnectAddress, $target.ConnectPort)
    }

    return $target
}

function Assert-HttpEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri
    )

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
            throw ('HTTP_STATUS={0}' -f $response.StatusCode)
        }
        return [int]$response.StatusCode
    } catch {
        throw ('HTTP_VERIFY_FAILED={0} {1}' -f $Uri, $_.Exception.Message)
    }
}

try {
    Write-Result -Name 'OFFICIAL_LAN_IP' -Value $OfficialLanIp
    Write-Result -Name 'OFFICIAL_LAN_PORT' -Value $OfficialLanPort
    Write-Result -Name 'FIREWALL_MUTATION' -Value 'NO'

    if (-not (Test-WindowsOwnsOfficialLanIp)) {
        Write-Result -Name 'LAN_FIXED_IP_LOST' -Value 'CURRENT_WINDOWS_LAN_IP_NOT_192.168.1.175'
        exit 2
    }

    $wslIPv4 = Get-CurrentWslIPv4
    Write-Result -Name 'CURRENT_WSL_IP' -Value $wslIPv4

    $entries = @(Get-PortProxyEntries)
    $target = @(
        $entries | Where-Object {
            $_.ListenAddress -eq $OfficialLanIp -and $_.ListenPort -eq $OfficialLanPort
        }
    )
    $isCorrect = $target.Count -eq 1 -and $target[0].ConnectAddress -eq $wslIPv4 -and $target[0].ConnectPort -eq $OfficialLanPort

    if ($isCorrect) {
        Write-Result -Name 'PORTPROXY' -Value ('NOOP {0}:{1}->{2}:{3}' -f $target[0].ListenAddress, $target[0].ListenPort, $target[0].ConnectAddress, $target[0].ConnectPort)
        Write-Result -Name 'SELF_HEAL_CURRENT_RUN' -Value 'NOOP'
    } else {
        Update-OfficialPortProxy -WslIPv4 $wslIPv4 -ExistingEntries $entries
        if (-not ($DryRun -or
            -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
            -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4))) {
            $target = Assert-OfficialPortProxy -WslIPv4 $wslIPv4
        }
        Write-Result -Name 'SELF_HEAL_CURRENT_RUN' -Value 'UPDATED'
    }

    $isSimulation = $DryRun -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)
    if ($isSimulation) {
        Write-Result -Name 'HTTP_VERIFY' -Value 'SKIPPED_SIMULATION'
    } else {
        $rootStatus = Assert-HttpEndpoint -Uri ('http://{0}:{1}/' -f $OfficialLanIp, $OfficialLanPort)
        $stateStatus = Assert-HttpEndpoint -Uri ('http://{0}:{1}/api/pet/state' -f $OfficialLanIp, $OfficialLanPort)
        Write-Result -Name 'WINDOWS_LAN_ROOT_HTTP' -Value $rootStatus
        Write-Result -Name 'WINDOWS_LAN_STATE_HTTP' -Value $stateStatus
    }

    exit 0
} catch {
    Write-Result -Name 'SELF_HEAL_ERROR' -Value $_.Exception.Message
    exit 3
}
