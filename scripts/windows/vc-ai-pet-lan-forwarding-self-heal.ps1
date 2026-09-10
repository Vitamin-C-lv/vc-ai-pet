[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$SimulatedWslIPv4,
    [string]$SimulatedWindowsLanIPv4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$LanInterfaceAlias = 'WLAN'
$LanPort = 17870
$FirewallRuleDisplayName = 'VC-AI-PET LAN Companion 17870'
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

function Test-PrivateLanIPv4 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $octets = $parsed.GetAddressBytes()
    return $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
}

function Assert-PrivateLanIPv4 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $normalized = Assert-IPv4 -Value $Value -Label $Label
    if (-not (Test-PrivateLanIPv4 -Value $normalized)) {
        throw ('{0}_NOT_PRIVATE_LAN={1}' -f $Label, $Value)
    }

    return $normalized
}

function Get-CurrentWindowsWlanIPv4 {
    if (-not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)) {
        return Assert-PrivateLanIPv4 -Value $SimulatedWindowsLanIPv4 -Label 'SIMULATED_WINDOWS_LAN_IPV4'
    }

    $adapter = Get-NetAdapter -Name $LanInterfaceAlias -ErrorAction SilentlyContinue
    if ($null -eq $adapter -or $adapter.Status -ne 'Up') {
        throw ('WINDOWS_WLAN_NOT_UP={0}' -f $LanInterfaceAlias)
    }

    $addresses = @(
        Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $LanInterfaceAlias -ErrorAction SilentlyContinue |
            Where-Object {
                $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*'
            }
    )
    if ($addresses.Count -ne 1) {
        throw ('WINDOWS_WLAN_IPV4_COUNT={0}' -f $addresses.Count)
    }

    return Assert-PrivateLanIPv4 -Value $addresses[0].IPAddress -Label 'WINDOWS_WLAN_IPV4'
}

function Get-CurrentWslIPv4 {
    if (-not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4)) {
        return Assert-IPv4 -Value $SimulatedWslIPv4 -Label 'SIMULATED_WSL_IPV4'
    }

    if (-not (Test-Path -LiteralPath $WslExe)) {
        throw ('WSL_EXECUTABLE_NOT_FOUND={0}' -f $WslExe)
    }

    $wslErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $WslExe -d $DistroName -- ip -4 -o addr show dev eth0 2>$null)
    } finally {
        $ErrorActionPreference = $wslErrorActionPreference
    }
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

function Get-LanPortProxyEntries {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$ExistingEntries
    )

    return @(
        $ExistingEntries | Where-Object {
            $_.ListenPort -eq $LanPort -and (Test-PrivateLanIPv4 -Value $_.ListenAddress)
        }
    )
}

function Update-LanPortProxy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsLanIPv4,
        [Parameter(Mandatory = $true)]
        [string]$WslIPv4,
        [Parameter(Mandatory = $true)]
        [object[]]$ExistingEntries
    )

    $isSimulation = $DryRun -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)
    if ($isSimulation) {
        Write-Result -Name 'PORTPROXY' -Value ('WOULD_UPDATE {0}:{1}->{2}:{1}' -f $WindowsLanIPv4, $LanPort, $WslIPv4)
        Write-Result -Name 'PORTPROXY_SCOPE' -Value 'LAN_TARGET_ONLY'
        return
    }

    $targetEntries = @(Get-LanPortProxyEntries -ExistingEntries $ExistingEntries)
    foreach ($entry in $targetEntries) {
        $deleteOutput = @(& $NetshExe interface portproxy delete v4tov4 listenaddress=$entry.ListenAddress listenport=$LanPort 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw ('PORTPROXY_DELETE_FAILED=exit_{0} {1}' -f $LASTEXITCODE, ($deleteOutput -join ' '))
        }
    }

    $addOutput = @(& $NetshExe interface portproxy add v4tov4 listenaddress=$WindowsLanIPv4 listenport=$LanPort connectaddress=$WslIPv4 connectport=$LanPort 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ('PORTPROXY_ADD_FAILED=exit_{0} {1}' -f $LASTEXITCODE, ($addOutput -join ' '))
    }

    Write-Result -Name 'PORTPROXY' -Value ('UPDATED {0}:{1}->{2}:{1}' -f $WindowsLanIPv4, $LanPort, $WslIPv4)
    Write-Result -Name 'PORTPROXY_REMOVED_LAN_TARGETS' -Value $targetEntries.Count
    Write-Result -Name 'PORTPROXY_SCOPE' -Value 'LAN_TARGET_ONLY'
}

function Assert-LanPortProxy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsLanIPv4,
        [Parameter(Mandatory = $true)]
        [string]$WslIPv4
    )

    $entries = @(Get-PortProxyEntries)
    $targetEntries = @(
        $entries | Where-Object {
            $_.ListenAddress -eq $WindowsLanIPv4 -and $_.ListenPort -eq $LanPort
        }
    )

    if ($targetEntries.Count -ne 1) {
        throw ('PORTPROXY_LAN_TARGET_COUNT={0}' -f $targetEntries.Count)
    }

    $target = $targetEntries[0]
    if ($target.ConnectAddress -ne $WslIPv4 -or $target.ConnectPort -ne $LanPort) {
        throw ('PORTPROXY_TARGET_MISMATCH={0}:{1}->{2}:{3}' -f $target.ListenAddress, $target.ListenPort, $target.ConnectAddress, $target.ConnectPort)
    }

    return $target
}

function Get-LanFirewallContext {
    $rules = @(Get-NetFirewallRule -DisplayName $FirewallRuleDisplayName -ErrorAction SilentlyContinue)
    if ($rules.Count -ne 1) {
        throw ('FIREWALL_RULE_COUNT={0}' -f $rules.Count)
    }

    $rule = $rules[0]
    $portFilter = $rule | Get-NetFirewallPortFilter
    $addressFilter = $rule | Get-NetFirewallAddressFilter
    $interfaceFilter = $rule | Get-NetFirewallInterfaceFilter

    if ($rule.Enabled -ne $true -or
        [string]$rule.Profile -ne 'Private' -or
        [string]$rule.Direction -ne 'Inbound' -or
        [string]$rule.Action -ne 'Allow') {
        throw 'FIREWALL_RULE_SCOPE_MISMATCH'
    }
    if ([string]$portFilter.Protocol -ne 'TCP' -or
        [string]$portFilter.LocalPort -ne [string]$LanPort) {
        throw 'FIREWALL_PORT_SCOPE_MISMATCH'
    }
    if (@($addressFilter.RemoteAddress).Count -eq 0 -or
        @($addressFilter.RemoteAddress) -contains 'Any') {
        throw 'FIREWALL_REMOTE_SCOPE_MISMATCH'
    }

    return [pscustomobject]@{
        Rule = $rule
        AddressFilter = $addressFilter
        InterfaceFilter = $interfaceFilter
    }
}

function Ensure-LanFirewallRule {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsLanIPv4
    )

    $context = Get-LanFirewallContext
    $currentLocalAddresses = @($context.AddressFilter.LocalAddress)
    $currentRemoteAddresses = @($context.AddressFilter.RemoteAddress)
    $currentInterfaces = @($context.InterfaceFilter.InterfaceAlias)
    $needsUpdate = $currentLocalAddresses.Count -ne 1 -or
        $currentLocalAddresses[0] -ne $WindowsLanIPv4 -or
        $currentRemoteAddresses.Count -ne 1 -or
        $currentRemoteAddresses[0] -ne 'LocalSubnet' -or
        $currentInterfaces.Count -ne 1 -or
        $currentInterfaces[0] -ne $LanInterfaceAlias

    $isSimulation = $DryRun -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)
    if ($isSimulation) {
        Write-Result -Name 'FIREWALL_MUTATION' -Value $(if ($needsUpdate) { 'WOULD_UPDATE' } else { 'NOOP' })
        Write-Result -Name 'FIREWALL_SCOPE' -Value 'LAN_RULE_ONLY'
        return
    }

    if ($needsUpdate) {
        $null = $context.AddressFilter | Set-NetFirewallAddressFilter -LocalAddress $WindowsLanIPv4 -RemoteAddress 'LocalSubnet' -ErrorAction Stop
        $null = $context.InterfaceFilter | Set-NetFirewallInterfaceFilter -InterfaceAlias $LanInterfaceAlias -ErrorAction Stop
        Write-Result -Name 'FIREWALL_MUTATION' -Value 'UPDATED'
    } else {
        Write-Result -Name 'FIREWALL_MUTATION' -Value 'NOOP'
    }
    Write-Result -Name 'FIREWALL_SCOPE' -Value 'LAN_RULE_ONLY'
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
    $windowsLanIPv4 = Get-CurrentWindowsWlanIPv4
    $wslIPv4 = Get-CurrentWslIPv4
    Write-Result -Name 'CURRENT_WINDOWS_WIFI_IPV4' -Value $windowsLanIPv4
    Write-Result -Name 'CURRENT_WSL_IP' -Value $wslIPv4
    Write-Result -Name 'LAN_PORTPROXY_LISTEN_ADDRESS' -Value ('{0}:{1}' -f $windowsLanIPv4, $LanPort)
    Write-Result -Name 'LAN_PORTPROXY_CONNECT_ADDRESS' -Value ('{0}:{1}' -f $wslIPv4, $LanPort)

    $entries = @(Get-PortProxyEntries)
    $lanTargets = @(Get-LanPortProxyEntries -ExistingEntries $entries)
    $isCorrect = $lanTargets.Count -eq 1 -and
        $lanTargets[0].ListenAddress -eq $windowsLanIPv4 -and
        $lanTargets[0].ConnectAddress -eq $wslIPv4 -and
        $lanTargets[0].ConnectPort -eq $LanPort

    if ($isCorrect) {
        Write-Result -Name 'PORTPROXY' -Value ('NOOP {0}:{1}->{2}:{3}' -f $lanTargets[0].ListenAddress, $lanTargets[0].ListenPort, $lanTargets[0].ConnectAddress, $lanTargets[0].ConnectPort)
        Write-Result -Name 'SELF_HEAL_CURRENT_RUN' -Value 'NOOP'
    } else {
        Update-LanPortProxy -WindowsLanIPv4 $windowsLanIPv4 -WslIPv4 $wslIPv4 -ExistingEntries $entries
        if (-not ($DryRun -or
            -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
            -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4))) {
            $null = Assert-LanPortProxy -WindowsLanIPv4 $windowsLanIPv4 -WslIPv4 $wslIPv4
        }
        Write-Result -Name 'SELF_HEAL_CURRENT_RUN' -Value 'UPDATED'
    }

    Ensure-LanFirewallRule -WindowsLanIPv4 $windowsLanIPv4

    $isSimulation = $DryRun -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWslIPv4) -or
        -not [string]::IsNullOrWhiteSpace($SimulatedWindowsLanIPv4)
    if ($isSimulation) {
        Write-Result -Name 'HTTP_VERIFY' -Value 'SKIPPED_SIMULATION'
    } else {
        $rootStatus = Assert-HttpEndpoint -Uri ('http://{0}:{1}/' -f $windowsLanIPv4, $LanPort)
        $stateStatus = Assert-HttpEndpoint -Uri ('http://{0}:{1}/api/pet/state' -f $windowsLanIPv4, $LanPort)
        Write-Result -Name 'WINDOWS_LAN_ROOT_HTTP' -Value $rootStatus
        Write-Result -Name 'WINDOWS_CURRENT_LAN_HTTP' -Value $stateStatus
    }

    exit 0
} catch {
    Write-Result -Name 'SELF_HEAL_ERROR' -Value $_.Exception.Message
    exit 3
}
