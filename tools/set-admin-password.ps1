# Run locally as the owner of this Supabase project. Never paste secrets into chat.
# Updates one EXISTING, email-confirmed org_members administrator; never grants roles.
$ErrorActionPreference = 'Stop'

function Read-PrivateText([string]$PromptText) {
    $privateValue = Read-Host $PromptText -AsSecureString
    $privatePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($privateValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($privatePointer) }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($privatePointer)
        $privateValue.Dispose()
    }
}

$adminHeaders = $null
$projectAdminKey = $null
$newAdminPassword = $null
$confirmAdminPassword = $null
$setupStep = 'Reading project configuration'
try {
    $configText = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\supabase-config.js') -Raw
    $projectMatch = [regex]::Match($configText, 'https://[a-z0-9-]+\.supabase\.co')
    if (-not $projectMatch.Success) { throw 'Could not find the project URL in supabase-config.js.' }
    $projectUrl = $projectMatch.Value
    Write-Host "Project: $projectUrl"
    Write-Host 'This changes only your existing administrator password. It does not send a reset email.'
    $adminEmail = (Read-Host 'Your existing administrator email').Trim().ToLowerInvariant()
    if ($adminEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Enter a valid email address.' }
    $projectAdminKey = (Read-PrivateText 'Supabase legacy service_role key (hidden; NOT the anon key)').Trim()
    if ($projectAdminKey.StartsWith('sb_')) {
        throw 'This helper needs the legacy service_role JWT key from Settings > API Keys > Legacy API Keys. The newer publishable/secret key format is not supported by this helper.'
    }
    $keyParts = $projectAdminKey.Split('.')
    if ($keyParts.Count -ne 3) { throw 'The key is not a complete legacy service_role key. Copy its full value, without quotes or the word Bearer.' }
    try {
        $keyPayload = $keyParts[1].Replace('-', '+').Replace('_', '/')
        $keyPayload = $keyPayload.PadRight($keyPayload.Length + ((4 - $keyPayload.Length % 4) % 4), '=')
        $keyInfo = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($keyPayload)) | ConvertFrom-Json
    } catch { throw 'The key could not be read. Copy the full legacy service_role key, without quotes or the word Bearer.' }
    if ($keyInfo.role -ne 'service_role') { throw 'This is not a service_role key. The public anon key cannot set administrator passwords.' }
    if ($keyInfo.ref -and $keyInfo.ref -ne ([Uri]$projectUrl).Host.Split('.')[0]) { throw 'The key belongs to a different Supabase project. Copy the service_role key from the project shown above.' }
    $adminHeaders = @{ apikey = $projectAdminKey; Authorization = "Bearer $projectAdminKey" }
    $emailFilter = [Uri]::EscapeDataString($adminEmail)
    $setupStep = 'Checking existing administrator membership'
    $members = @(Invoke-RestMethod -Method Get -Uri "$projectUrl/rest/v1/org_members?select=user_id,email,role&email=eq.$emailFilter&role=eq.admin" -Headers $adminHeaders)
    if ($members.Count -ne 1 -or $members[0].role -ne 'admin') { throw 'No matching existing administrator was found. No changes made.' }
    $adminId = [string]$members[0].user_id
    if ($adminId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Invalid administrator record. No changes made.' }
    $setupStep = 'Checking verified Auth account'
    $authAccount = Invoke-RestMethod -Method Get -Uri "$projectUrl/auth/v1/admin/users/$adminId" -Headers $adminHeaders
    if ($authAccount.email.ToLowerInvariant() -ne $adminEmail -or -not $authAccount.email_confirmed_at) {
        throw 'This account must already have its email verified. Accept an invitation after email delivery is available. No changes made.'
    }
    $newAdminPassword = Read-PrivateText 'New unique password (at least 12 characters; hidden)'
    $confirmAdminPassword = Read-PrivateText 'Repeat new password (hidden)'
    if ($newAdminPassword.Length -lt 12 -or $newAdminPassword -cne $confirmAdminPassword) { throw 'Passwords must match and contain at least 12 characters. No changes made.' }
    $passwordBody = @{ password = $newAdminPassword } | ConvertTo-Json -Compress
    $setupStep = 'Updating the administrator password'
    $null = Invoke-RestMethod -Method Put -Uri "$projectUrl/auth/v1/admin/users/$adminId" -Headers $adminHeaders -ContentType 'application/json' -Body $passwordBody
    Write-Host 'Password updated. After publishing the website update, select Administrator sign-in and use your email and new password.'
} catch {
    if ($_.Exception -is [System.Net.WebException] -or $_.Exception.GetType().Name -eq 'HttpResponseException') {
        $failedRequest = $_
        $httpStatus = $null
        try { $httpStatus = [int]$failedRequest.Exception.Response.StatusCode } catch {}
        Write-Host "Failed step: $setupStep"
        if ($httpStatus) { Write-Host "HTTP status: $httpStatus" }
        $safeDetail = $null
        try {
            $errorBody = $failedRequest.ErrorDetails.Message
            if (-not $errorBody -and $failedRequest.Exception.Response -is [System.Net.HttpWebResponse]) {
                $errorReader = New-Object IO.StreamReader($failedRequest.Exception.Response.GetResponseStream())
                try { $errorBody = $errorReader.ReadToEnd() } finally { $errorReader.Dispose() }
            }
            $errorPayload = $errorBody | ConvertFrom-Json
            foreach ($fieldName in @('msg', 'message', 'error_description', 'error_code', 'code', 'error')) {
                $candidate = $errorPayload.$fieldName
                if ($candidate -is [string] -and $candidate.Trim()) { $safeDetail = $candidate; break }
            }
        } catch { }
        if ($safeDetail) {
            foreach ($sensitiveValue in @($projectAdminKey, $newAdminPassword, $confirmAdminPassword)) {
                if ($sensitiveValue) { $safeDetail = $safeDetail.Replace($sensitiveValue, '[hidden]') }
            }
            $safeDetail = [regex]::Replace($safeDetail, '(?i)(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+)', '[hidden key]')
            $safeDetail = [regex]::Replace($safeDetail, '[\x00-\x1F\x7F]', ' ')
            if ($safeDetail.Length -gt 300) { $safeDetail = $safeDetail.Substring(0, 300) }
            Write-Host "Supabase message: $safeDetail"
        } else { Write-Host 'No readable Supabase error was returned. The connection or project key may need checking.' }
        if ($httpStatus -eq 401 -or $httpStatus -eq 403) { Write-Host 'Check that this is the full legacy service_role key for this exact project, not the public anon key.' }
        if ($httpStatus -eq 429) { Write-Host 'This request is also rate-limited. Stop retrying and wait before another attempt.' }
        Write-Host 'Secret values have not been printed. Share only the failed step, HTTP status, and Supabase message for troubleshooting.'
    } else { Write-Host $_.Exception.Message }
    throw 'Password setup did not complete. Do not share your secret key or password.'
} finally {
    if ($adminHeaders) { $adminHeaders.Clear() }
    $projectAdminKey = $null
    $newAdminPassword = $null
    $confirmAdminPassword = $null
    $passwordBody = $null
    $configText = $null
    $keyParts = $null
    $keyPayload = $null
    $keyInfo = $null
    $errorBody = $null
    $errorPayload = $null
}
