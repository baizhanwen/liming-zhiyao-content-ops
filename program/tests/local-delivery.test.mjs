import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("local identity is opt-in, loopback-only, and forwarded identity requires a trusted proxy", async () => {
  const auth = await readFile(new URL("../lib/request-auth.ts", import.meta.url), "utf8");
  assert.match(auth, /LOCAL_DEV_AUTH/);
  assert.match(auth, /hostname === "localhost"/);
  assert.match(auth, /hostname === "127\.0\.0\.1"/);
  assert.match(auth, /hostname === "\[::1\]"/);
  assert.match(auth, /TRUST_FORWARDED_IDENTITY/);
  assert.match(auth, /TRUST_FORWARDED_IDENTITY\?\.trim\(\) === "1"[\s\S]*readForwardedIdentity/);
  assert.match(auth, /readLocalSessionIdentity\(request\)[\s\S]*TRUST_FORWARDED_IDENTITY/);
});

test("normal startup stays on loopback while LAN mode is an explicit opt-in", async () => {
  const vite = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  const lanStart = await readFile(new URL("../scripts/start-lan.ps1", import.meta.url), "utf8");
  assert.match(vite, /host: lanMode \? "0\.0\.0\.0" : "127\.0\.0\.1"/);
  assert.match(lanStart, /LAN_MODE = "1"/);
  assert.match(lanStart, /LAN_ACCESS_ORIGIN/);
  assert.match(lanStart, /Test-PrivateLanAddress/);
  assert.match(lanStart, /Meta\|Tunnel\|Virtual/);
  assert.match(vite, /services\/analyzer\/\.venv/);
  assert.match(vite, /services\/analyzer\/model-cache/);
});

test("team launch scripts install, migrate, start analysis automatically, stop safely, and expose a health check", async () => {
  const [setup, start, lanStart, stop, stopScript, analyzerStart, analyzerSupervisor, openLocal, portSelector, packageJson, migrations, health, config, deliveryScript, pythonInstaller, vcInstaller, nodeInstaller, ffmpegInstaller, deliveryGuide] = await Promise.all([
    readFile(new URL("../setup-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../start-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-lan.ps1", import.meta.url), "utf8"),
    readFile(new URL("../stop-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../scripts/stop-local.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-analyzer-background.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-analyzer-supervisor.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/open-local.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/select-local-port.ps1", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-local-migrations.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.local.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-delivery.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-python311.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-vcredist.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-node22.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-ffmpeg.ps1", import.meta.url), "utf8"),
    readFile(new URL("../resources/delivery/DELIVERY-GUIDE.txt", import.meta.url), "utf8"),
  ]);
  assert.match(setup, /Installing web dependencies/);
  assert.match(setup, /install-node22\.ps1/);
  assert.match(setup, /--check-runtime/);
  assert.match(setup, /process\.arch === 'x64'/);
  assert.match(setup, /major === 22 && minor >= 13/);
  assert.match(setup, /call "%NPM_CMD%" ci/);
  assert.match(setup, /node_modules\\wrangler\\bin\\wrangler\.js/);
  assert.match(setup, /Web dependencies passed completeness verification/);
  assert.match(setup, /Windows Security quarantine and folder permissions/);
  const preparation = await readFile(new URL("../scripts/prepare-local-web.ps1", import.meta.url), "utf8");
  assert.match(start, /prepare-local-web\.ps1/);
  assert.match(lanStart, /prepare-local-web\.ps1/);
  assert.match(preparation, /node_modules\\wrangler\\bin\\wrangler\.js/);
  assert.match(preparation, /node_modules\\wrangler\\bin\\wrangler\.js/);
  assert.match(preparation, /Web dependencies are missing or incomplete/);
  assert.match(preparation, /db:local:migrate/);
  assert.match(preparation, /knowledge:local:sync/);
  assert.match(start, /LOCAL_APP_URL=http:\/\/127\.0\.0\.1:%LOCAL_APP_PORT%/);
  assert.match(start, /select-local-port\.ps1/);
  assert.match(start, /The app is already running[\s\S]*start-analyzer-background\.ps1/);
  assert.match(start, /findstr "LISTENING"/);
  assert.match(start, /Port %LOCAL_APP_PORT% is occupied by an unhealthy process/);
  assert.match(start, /The web app stopped unexpectedly/);
  assert.match(stop, /scripts\\stop-local\.ps1/);
  assert.match(stopScript, /Get-NetTCPConnection/);
  assert.match(stopScript, /param\(\[switch\]\$CheckOnly\)/);
  assert.match(stopScript, /Port \$appPort belongs to another program/);
  assert.match(stopScript, /vinext\.\+dev/);
  assert.match(stopScript, /taskkill\.exe \/PID \$targetId \/T \/F/);
  assert.match(stopScript, /analyzer\.pid/);
  assert.match(stopScript, /liming_analyzer/);
  assert.match(stopScript, /run-analyzer-supervisor\.ps1/);
  assert.match(analyzerStart, /run-analyzer-supervisor\.ps1/);
  assert.match(analyzerStart, /Start-Process -FilePath "powershell\.exe"/);
  assert.match(analyzerStart, /analyzer\.pid/);
  assert.match(analyzerStart, /analyzer\.base-url/);
  assert.match(analyzerStart, /taskkill\.exe \/PID \$savedId \/T \/F/);
  assert.match(analyzerStart, /Environment\]::GetEnvironmentVariable/);
  assert.match(analyzerStart, /Remove-Item Env:ANALYZER_FFMPEG/);
  assert.match(analyzerStart, /Remove-Item Env:ANALYZER_FFPROBE/);
  assert.match(analyzerStart, /analyzer-media-runtime\.ps1/);
  assert.match(analyzerStart, /Import-AnalyzerMediaRuntime/);
  assert.match(analyzerSupervisor, /while \(\$true\)/);
  assert.match(analyzerSupervisor, /will retry automatically/);
  assert.match(analyzerSupervisor, /ANALYZER_BASE_URL/);
  assert.match(analyzerSupervisor, /analyzer-supervisor\.log/);
  assert.match(analyzerSupervisor, /Import-AnalyzerMediaRuntime/);
  assert.match(analyzerSupervisor, /Remove-Item Env:ANALYZER_FFMPEG/);
  assert.match(analyzerSupervisor, /Remove-Item Env:ANALYZER_FFPROBE/);
  assert.match(openLocal, /open-web\.ps1/);
  assert.match(await readFile(new URL("../scripts/open-web.ps1", import.meta.url), "utf8"), /start-analyzer-background\.ps1/);
  assert.match(portSelector, /TcpListener/);
  assert.match(portSelector, /3000, 3100, 3200, 5173/);
  assert.match(portSelector, /app\.port/);
  assert.match(packageJson, /db:local:migrate/);
  assert.match(migrations, /WRANGLER_WRITE_LOGS/);
  assert.match(config, /"migrations_dir": "drizzle"/);
  assert.match(health, /SELECT 1 AS ready/);
  assert.doesNotMatch(health, /ANALYZER_SERVICE_TOKEN|CONTENT_MODEL_API_KEY/);
  const analyzerSetup = await readFile(new URL("../tools/setup-analyzer.bat", import.meta.url), "utf8");
  const manualAnalyzerStart = await readFile(new URL("../tools/start-analyzer.bat", import.meta.url), "utf8");
  const analyzerDiagnostic = await readFile(new URL("../scripts/check-analyzer.ps1", import.meta.url), "utf8");
  const analyzerMediaRuntime = await readFile(new URL("../scripts/analyzer-media-runtime.ps1", import.meta.url), "utf8");
  const analyzerConstraints = await readFile(new URL("../services/analyzer/constraints-windows.txt", import.meta.url), "utf8");
  assert.match(analyzerSetup, /:find_python/);
  assert.match(analyzerSetup, /--check-python/);
  assert.match(analyzerSetup, /install-python311\.ps1/);
  assert.match(analyzerSetup, /install-vcredist\.ps1/);
  assert.match(analyzerSetup, /install-ffmpeg\.ps1/);
  assert.match(analyzerSetup, /ffmpeg -version/);
  assert.match(analyzerSetup, /ffprobe -version/);
  assert.match(analyzerSetup, /goto :ffmpeg_failed/);
  assert.match(analyzerSetup, /:start_analyzer_if_app_is_running/);
  assert.match(analyzerSetup, /\.local\\app\.port/);
  assert.match(analyzerSetup, /start-analyzer-background\.ps1/);
  assert.match(analyzerSetup, /PIP_CONFIG_FILE=NUL/);
  assert.match(analyzerSetup, /PIP_REQUIRE_HASHES=/);
  assert.match(analyzerSetup, /https:\/\/pypi\.org\/simple/);
  assert.match(analyzerSetup, /https:\/\/mirrors\.aliyun\.com\/pypi\/simple/);
  assert.match(analyzerSetup, /PYPI_FALLBACK/);
  assert.match(analyzerSetup, /--index aliyun\^\|official/);
  assert.match(analyzerSetup, /--no-cache-dir/);
  assert.match(analyzerSetup, /setuptools==81\.0\.0/);
  assert.match(analyzerSetup, /--retries 20 --timeout 120/);
  assert.match(analyzerSetup, /--resume-retries 20/);
  assert.match(analyzerSetup, /constraints-windows\.txt/);
  assert.match(analyzerSetup, /--constraint "%PYTHON_CONSTRAINT%"/);
  assert.match(analyzerSetup, /Verifying the complete locked analyzer runtime/);
  assert.match(analyzerSetup, /pip check/);
  assert.match(analyzerSetup, /Removing incompatible legacy video packages/);
  assert.match(analyzerSetup, /incompatible video packages remain installed/);
  assert.doesNotMatch(analyzerSetup, / -e "services\\analyzer\[media\]"/);
  assert.match(manualAnalyzerStart, /\.local\\app\.port/);
  assert.match(manualAnalyzerStart, /-BaseUrl "http:\/\/127\.0\.0\.1:%LOCAL_APP_PORT%"/);
  for (const pinned of ["paddlepaddle==3.2.0", "paddleocr==3.7.0", "paddlex==3.7.2", "torch==2.11.0", "torchaudio==2.11.0", "opencv-contrib-python==4.10.0.84", "mcp==2.1.0", "mcp-types==2.1.0", "minimax-coding-plan-mcp==0.0.5"]) {
    assert.match(analyzerConstraints, new RegExp(pinned.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(analyzerConstraints, /^opencv-python==/m);
  assert.doesNotMatch(analyzerConstraints, /^scenedetect==/m);
  assert.match(analyzerSetup, /pip cache purge/);
  assert.match(analyzerSetup, /Loading native analyzer modules/);
  assert.match(analyzerSetup, /minimax_mcp\.server/);
  assert.match(analyzerSetup, /platform\.machine/);
  assert.match(analyzerDiagnostic, /pip check/);
  assert.match(analyzerDiagnostic, /torch,torchaudio,paddle,cv2/);
  assert.match(analyzerDiagnostic, /analyzer-start-error\.txt/);
  assert.match(analyzerDiagnostic, /catch \[IO\.IOException\]/);
  assert.match(analyzerDiagnostic, /No analyzer startup error is recorded/);
  assert.match(analyzerDiagnostic, /Secret values are not printed/);
  assert.match(analyzerDiagnostic, /Host-level ANALYZER_FFMPEG\/ANALYZER_FFPROBE values are ignored/);
  assert.match(analyzerMediaRuntime, /\.local\\ffmpeg\.path/);
  assert.match(analyzerMediaRuntime, /ANALYZER_FFMPEG/);
  assert.match(analyzerMediaRuntime, /ANALYZER_FFPROBE/);
  assert.match(analyzerMediaRuntime, /\$env:Path = \$pathEntries -join ";"/);
  assert.match(analyzerMediaRuntime, /third-party media helpers/);
  assert.match(analyzerMediaRuntime, /Text\.DecoderFallbackException/);
  assert.doesNotMatch(analyzerSetup, /winget|start "" "https:\/\//i);
  assert.match(pythonInstaller, /https:\/\/www\.python\.org\/ftp\/python\/\$Version\/\$fileName/);
  assert.match(pythonInstaller, /https:\/\/mirrors\.aliyun\.com\/python-release\/windows\/\$fileName/);
  assert.match(pythonInstaller, /Invoke-WebRequest/);
  assert.match(pythonInstaller, /Start-BitsTransfer/);
  assert.match(pythonInstaller, /Get-AuthenticodeSignature/);
  assert.match(pythonInstaller, /Python Software Foundation/);
  assert.match(pythonInstaller, /"\/quiet"/);
  assert.match(pythonInstaller, /InstallAllUsers=0/);
  assert.match(vcInstaller, /https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
  assert.match(vcInstaller, /Get-AuthenticodeSignature/);
  assert.match(vcInstaller, /Microsoft Corporation/);
  assert.match(vcInstaller, /-Verb RunAs/);
  assert.match(nodeInstaller, /https:\/\/nodejs\.org\/dist\/v\$Version\/\$fileName/);
  assert.match(nodeInstaller, /Get-AuthenticodeSignature/);
  assert.match(nodeInstaller, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.match(nodeInstaller, /ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989/);
  assert.match(nodeInstaller, /OpenJS Foundation\|Node\\\.js Foundation/);
  assert.match(nodeInstaller, /Start-BitsTransfer/);
  assert.match(nodeInstaller, /msiexec\.exe/);
  assert.match(nodeInstaller, /process\.arch === 'x64'/);
  assert.match(nodeInstaller, /Text\.Encoding\]::Default/);
  assert.match(ffmpegInstaller, /winget\.exe/);
  assert.match(ffmpegInstaller, /--id Gyan\.FFmpeg --exact --source winget/);
  assert.match(ffmpegInstaller, /App Installer/);
  assert.match(ffmpegInstaller, /Test-MediaBinary/);
  assert.match(ffmpegInstaller, /FFmpeg\/ffprobe could not be verified after installation/);
  assert.match(ffmpegInstaller, /SetEnvironmentVariable\("Path", \(\$entries -join ";"\), "User"\)/);
  assert.match(ffmpegInstaller, /SendMessageTimeout/);
  assert.match(ffmpegInstaller, /Text\.Encoding\]::Default/);
  assert.match(deliveryGuide, /Node\.js 22\.13/);
  assert.match(deliveryGuide, /Windows Package Manager（winget）/);
  assert.match(deliveryGuide, /一键配置环境并启动/);
  assert.match(deliveryGuide, /显示进度与实际结果/);
  assert.match(deliveryScript, /\.Extension -in @\("\.bat", "\.cmd"\)/);
  assert.match(deliveryScript, /Regex\]::Replace\(\$batchContent, "\\r\?\\n", "`r`n"\)/);
});

test("Windows batch entry points are ASCII-only and checked out with CRLF", async () => {
  const files = ["setup-local.bat", "start-local.bat", "stop-local.bat", "start-lan.bat", "factory-reset.bat", "prepare-delivery.bat", "tools/setup-analyzer.bat", "tools/start-analyzer.bat", "tools/check-analyzer.bat", "tools/repair-analyzer-ocr.bat", "tools/refresh-douyin-cookies.bat", "tools/install-cookie-export-extension.bat", "tools/backup-local.bat", "tools/restore-local.bat"];
  const contents = await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url))));
  for (const [index, buffer] of contents.entries()) {
    const content = buffer.toString("utf8");
    assert.equal(Array.from(content).every((character) => character.codePointAt(0) <= 127), true, `${files[index]} must stay ASCII-safe for cmd.exe`);
    assert.doesNotMatch(content, /(^|[^\r])\n/, `${files[index]} must use CRLF so cmd.exe can resolve labels reliably`);
  }
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /\*\.bat text eol=crlf/);
});

test("LAN accounts use hardened password hashes and server-side sessions", async () => {
  const [schema, auth, session, invitation] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/invitations/accept/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /local_credentials/);
  assert.match(schema, /local_sessions/);
  assert.match(schema, /local_login_attempts/);
  assert.match(auth, /PBKDF2/);
  assert.match(auth, /210_000/);
  assert.match(auth, /HttpOnly; SameSite=Lax/);
  assert.match(session, /verifyLocalLogin/);
  assert.match(session, /LOGIN_TEMPORARILY_LOCKED/);
  assert.match(invitation, /setLocalPassword/);
});
