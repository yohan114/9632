# WorkshopOne - daily off-site copy of the newest server backup, pulled to a Windows PC.
#
# WHY. The server takes a snapshot every 30 minutes, but all of them sit on the server itself. That
# covers a mistake in the app; it covers nothing about losing the server - a provider failure, a
# deleted VM, a ransomware attack on the machine. This copies the newest snapshot to a PC in the
# office once a day, checks it arrived byte-for-byte (SHA-256 on both ends), and keeps 30 days.
#
# ONE-TIME SETUP (see deploy/VPS.md, "Backups"):
#   1. On the server, an ordinary account with no sudo that can read the backups but change nothing
#      (full commands in deploy/VPS.md):
#        sudo adduser --disabled-password --gecos "" wo-backup && sudo usermod -aG workshopone wo-backup
#   2. On this PC, a key with no passphrase for that account only, and install it on the server:
#        ssh-keygen -t ed25519 -f $HOME\.ssh\wo_backup -N '""'
#        type $HOME\.ssh\wo_backup.pub | ssh <your-admin-user>@<server-ip> "sudo mkdir -p /home/wo-backup/.ssh && sudo tee -a /home/wo-backup/.ssh/authorized_keys >/dev/null && sudo chown -R wo-backup: /home/wo-backup/.ssh && sudo chmod 700 /home/wo-backup/.ssh && sudo chmod 600 /home/wo-backup/.ssh/authorized_keys"
#   3. Test by hand:   powershell -ExecutionPolicy Bypass -File D:\WorkshopOne-offsite\offsite-pull.ps1
#   4. Schedule it daily (runs when the PC is next on, if it was off at the time):
#        $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "D:\WorkshopOne-offsite\offsite-pull.ps1"'
#        $t = New-ScheduledTaskTrigger -Daily -At 12:30pm
#        $s = New-ScheduledTaskSettingsSet -StartWhenAvailable
#        Register-ScheduledTask -TaskName 'WorkshopOne off-site backup' -Action $a -Trigger $t -Settings $s
#
# The copies hold the company's whole database. Keep this folder on a drive with BitLocker on, and
# do not put it in a folder that syncs to a personal cloud account.

param(
  [string]$Server    = 'wo-backup@20.204.51.43',   # the server's own address: SSH does not go through Cloudflare
  [string]$Key       = "$HOME\.ssh\wo_backup",
  [string]$RemoteDir = '/opt/workshopone/backups',
  [string]$LocalDir  = 'D:\WorkshopOne-offsite',
  [int]$KeepDays     = 30
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
$log = Join-Path $LocalDir 'offsite-pull.log'
function Log($msg) { $line = "$(Get-Date -Format s)  $msg"; Add-Content -Path $log -Value $line; Write-Output $line }

$ssh = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')

try {
  # The newest snapshot that is at least 2 minutes old - never the one the scheduler may still be writing.
  $name = (& ssh @ssh $Server "find '$RemoteDir' -maxdepth 1 -name 'workshopone-*.db' -mmin +2 -printf '%f\n' | sort | tail -n 1").Trim()
  if (-not $name) { throw "No finished snapshot found in $RemoteDir on the server." }

  $dest = Join-Path $LocalDir $name
  if (Test-Path $dest) { Log "SKIP  $name already copied"; exit 0 }

  $remoteHash = ((& ssh @ssh $Server "sha256sum '$RemoteDir/$name'") -split '\s+')[0].ToLower()
  & scp @ssh "${Server}:$RemoteDir/$name" "$dest.part"
  if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }

  $localHash = (Get-FileHash -Algorithm SHA256 "$dest.part").Hash.ToLower()
  if ($localHash -ne $remoteHash) {
    Remove-Item "$dest.part" -Force
    throw "Checksum mismatch for $name (server $remoteHash, copy $localHash) - copy discarded."
  }
  Move-Item "$dest.part" $dest
  $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  Log "OK    $name  $mb MB  sha256 $localHash"

  # Keep $KeepDays days, but never delete the newest good copy, whatever its age.
  $old = Get-ChildItem $LocalDir -Filter 'workshopone-*.db' | Sort-Object Name | Select-Object -SkipLast 1 |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
  foreach ($f in $old) { Remove-Item $f.FullName -Force; Log "PRUNE $($f.Name)" }
  exit 0
}
catch {
  Log "FAIL  $($_.Exception.Message)"
  exit 1
}
