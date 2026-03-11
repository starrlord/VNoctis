# VNoctis Manager — Build & Push to Local Registry
# Registry: docker.yourrepo.com
#
# Usage:
#   .\build-and-push.ps1              # Build and push all containers with 'latest' tag
#   .\build-and-push.ps1 -Tag v1.0.0  # Build and push with specific version tag
#   .\build-and-push.ps1 -Service api # Build and push only the api service
#   .\build-and-push.ps1 -NoPush      # Build only, don't push
#

param(
    [string]$Tag = "latest",
    [ValidateSet("all", "api", "builder", "ui")]
    [string]$Service = "all",
    [switch]$NoPush,
    [switch]$NoCache
)

$Registry = "docker.yourrepo.com"
$ProjectName = "vnm"
$ErrorActionPreference = "Stop"

# Image names
$Images = @{
    api     = @{ Name = "$Registry/$ProjectName/vnm-api"; Context = "services/vnm-api"; Dockerfile = "services/vnm-api/Dockerfile" }
    builder = @{ Name = "$Registry/$ProjectName/vnm-builder"; Context = "services/vnm-builder"; Dockerfile = "services/vnm-builder/Dockerfile" }
    ui      = @{ Name = "$Registry/$ProjectName/vnm-ui"; Context = "services/vnm-ui"; Dockerfile = "services/vnm-ui/Dockerfile" }
}

function Write-Step($message) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $message" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
}

function Build-Image($key) {
    $img = $Images[$key]
    $fullTag = "$($img.Name):$Tag"
    $latestTag = "$($img.Name):latest"

    Write-Step "Building $fullTag"

    $buildArgs = @("build", "-t", $fullTag, "-f", $img.Dockerfile, $img.Context)

    # Also tag as latest if we're using a version tag
    if ($Tag -ne "latest") {
        $buildArgs += @("-t", $latestTag)
    }

    if ($NoCache) {
        $buildArgs += "--no-cache"
    }

    & docker @buildArgs

    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to build $fullTag" -ForegroundColor Red
        exit 1
    }

    Write-Host "✅ Built $fullTag" -ForegroundColor Green
}

function Push-Image($key) {
    $img = $Images[$key]
    $fullTag = "$($img.Name):$Tag"
    $latestTag = "$($img.Name):latest"

    Write-Step "Pushing $fullTag"

    & docker push $fullTag

    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to push $fullTag" -ForegroundColor Red
        exit 1
    }

    # Also push latest tag if version-tagged
    if ($Tag -ne "latest") {
        Write-Host "Pushing $latestTag..."
        & docker push $latestTag
    }

    Write-Host "✅ Pushed $fullTag" -ForegroundColor Green
}

# Header
Write-Host ""
Write-Host "🎮 VNoctis Manager — Build & Push" -ForegroundColor Magenta
Write-Host "   Registry:  $Registry" -ForegroundColor Gray
Write-Host "   Tag:       $Tag" -ForegroundColor Gray
Write-Host "   Service:   $Service" -ForegroundColor Gray
Write-Host "   No Push:   $NoPush" -ForegroundColor Gray
Write-Host "   No Cache:  $NoCache" -ForegroundColor Gray
Write-Host ""

# Determine which services to build
$servicesToBuild = if ($Service -eq "all") { @("api", "builder", "ui") } else { @($Service) }

# Build phase
$startTime = Get-Date

foreach ($svc in $servicesToBuild) {
    Build-Image $svc
}

# Push phase
if (-not $NoPush) {
    foreach ($svc in $servicesToBuild) {
        Push-Image $svc
    }
}

$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✅ Complete! ($([math]::Round($elapsed.TotalSeconds, 1))s)" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

# Print the image tags for reference
Write-Host "Images:" -ForegroundColor Yellow
foreach ($svc in $servicesToBuild) {
    $img = $Images[$svc]
    Write-Host "  $($img.Name):$Tag" -ForegroundColor White
}
Write-Host ""
