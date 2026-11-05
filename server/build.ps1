# 打包 FastAPI 后端为单文件 backend.exe（PyInstaller）
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here ".venv\Scripts\python.exe"

& $py -m pip install pyinstaller --quiet

Push-Location $here
& $py -m PyInstaller --noconfirm --clean --onefile --name backend `
  --hidden-import app.main `
  --hidden-import multipart `
  --collect-all uvicorn `
  run.py
Pop-Location

Write-Host "=> $here\dist\backend.exe"
