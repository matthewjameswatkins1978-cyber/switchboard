# Launch the native stdio plug with a current-user Windows DPAPI credential.
# Keep stdout reserved for MCP frames.
param(
    [Parameter(Mandatory)][string]$Origin,
    [Parameter(Mandatory)][string]$Endpoint,
    [Parameter(Mandatory)][string]$Mailbox,
    [Parameter(Mandatory)][string]$CredentialFile
)

$ErrorActionPreference = 'Stop'
try {
    $entry = Join-Path $PSScriptRoot 'dist/mcp/codex-plug.js'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw 'Build the Switchboard plug before launching it.'
    }
    $protected = [IO.File]::ReadAllText($CredentialFile)
    $secret = ConvertTo-SecureString $protected
    $env:SWITCHBOARD_TOKEN = ConvertFrom-SecureString $secret -AsPlainText
    $env:SWITCHBOARD_URL = $Origin
    $env:SWITCHBOARD_ENDPOINT = $Endpoint
    $env:SWITCHBOARD_MAILBOX = $Mailbox
    & node $entry
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:SWITCHBOARD_TOKEN -ErrorAction SilentlyContinue
}
