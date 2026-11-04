$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  Write-Error "Node.js 20+ and npm are required. Install the Node.js LTS release, then reopen PowerShell."
}
$nodeMajor = [int]((node -p "process.versions.node").Split(".")[0])
if ($nodeMajor -lt 20) {
  Write-Error "Node.js 20 or newer is required. Detected: $(node --version)"
}

if (-not (Test-Path ".env")) {
  if (-not (Test-Path ".env.example")) { throw ".env.example is missing." }
  $envText = Get-Content ".env.example" -Raw
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $jwtBytes = New-Object byte[] 48
    $passwordBytes = New-Object byte[] 24
    $rng.GetBytes($jwtBytes)
    $rng.GetBytes($passwordBytes)
  } finally { $rng.Dispose() }
  $jwtSecret = ([System.BitConverter]::ToString($jwtBytes)).Replace("-", "").ToLowerInvariant()
  $adminPassword = [Convert]::ToBase64String($passwordBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  $envText = $envText.Replace("REPLACE_WITH_A_UNIQUE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS", $jwtSecret)
  $envText = $envText.Replace("REPLACE_WITH_A_UNIQUE_PASSWORD_AT_LEAST_14_CHARS", $adminPassword)
  [System.IO.File]::WriteAllText((Join-Path $root ".env"), $envText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Created .env with cryptographically random secrets."
  Write-Host "Initial administrator username: admin"
  Write-Host "Initial administrator password: $adminPassword" -ForegroundColor Yellow
  Write-Host "Save this password securely. It will not be displayed again."
} else {
  Write-Host "Existing .env found; it will not be overwritten."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
} else {
  Write-Host "node_modules already exists; skipping dependency installation."
}
Write-Host "Local setup is ready. Start the app with: npm start"
