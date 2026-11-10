; ClaudeNotifier.iss -- Inno Setup 6 script for ClaudeNotifierSetup.exe (per-user, no administrator rights, no network).
; Built by tools/build-installer.js from a COPY of the verified release stage; never edit the stage.
;
; Defines (passed by the build script):  PayloadDir  OutDir  OutName  AppVersion  StopB64   [TestMode]
;   TestMode builds a variant with its own application id, shortcut name, startup value name and toast key, so that it can be
;   installed / upgraded / uninstalled on a machine that has the real product without touching a single real entry.
;
; User data (%USERPROFILE%\.claude-notifier: settings, appearance, ntfy.json, phone setup, history, logs) is never read, written
; or deleted by this installer or by its uninstaller.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifdef TestMode
  #define AppName "Claude Notifier (installer test)"
  #define AppIdGuid "{{6A1F0D3E-7C52-4B9E-8D14-0E2B5A97C3F1}"
  #define RunValueName "ClaudeNotifierInstallerTest"
  #define AumidKey "Software\Classes\AppUserModelId\ClaudeNotifier.InstallerTest"
  #define AumidParam ""
#else
  #define AppName "Claude Notifier"
  #define AppIdGuid "{{9D2E6C1A-4B7F-4E0B-9C5A-3F6B1A7D2E10}"
  #define RunValueName "ClaudeNotifier"
  #define AumidKey "Software\Classes\AppUserModelId\ClaudeNotifier.Companion"
  #define AumidParam "; AppUserModelID: ""ClaudeNotifier.Companion"""
#endif
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"

[Setup]
AppId={#AppIdGuid}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Claude Notifier
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupMutex={#RunValueName}SetupMutex
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\ClaudeNotifier.exe
SetupLogging=yes
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nClaude Notifier watches your Claude Code sessions and tells you when Claude needs you, with a Windows notification and, if you set it up, a phone notification.%n%nNo administrator rights are needed and nothing is downloaded. Your settings and phone setup are never deleted by Setup or by uninstalling.
FinishedLabel=Setup has finished installing [name] on your computer.

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked
Name: "autostart"; Description: "&Start Claude Notifier when I sign in to Windows"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\MANIFEST.txt"; DestDir: "{app}\release-info"; Flags: ignoreversion
Source: "{#PayloadDir}\RUNTIME.txt"; DestDir: "{app}\release-info"; Flags: ignoreversion

[InstallDelete]
; an upgrade replaces the previous application files completely (a file that no longer exists in the new version must not survive);
; Inno's own uninstall files (unins000.*) and every other folder are left alone
Type: filesandordirs; Name: "{app}\LICENSES"
Type: filesandordirs; Name: "{app}\release-info"
Type: files; Name: "{app}\*.js"
Type: files; Name: "{app}\*.ps1"
Type: files; Name: "{app}\*.vbs"
Type: files; Name: "{app}\*.txt"

[Icons]
; the SAME file the application keeps for its toast identity (Programs\Claude Notifier.lnk): one icon, never two
Name: "{userprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Claude-Notifier.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNotifier.exe"; Comment: "Claude Notifier"{#AumidParam}
Name: "{userdesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Claude-Notifier.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNotifier.exe"; Tasks: desktopicon

[Run]
; first install: the usual "Launch" checkbox on the last page; upgrade over a RUNNING app: it is started again, exactly once, automatically
Filename: "{sys}\wscript.exe"; Parameters: """{app}\Claude-Notifier.vbs"""; WorkingDir: "{app}"; Description: "Launch Claude Notifier now"; Flags: nowait postinstall skipifsilent; Check: not WasRunning
Filename: "{sys}\wscript.exe"; Parameters: """{app}\Claude-Notifier.vbs"""; WorkingDir: "{app}"; Flags: nowait runhidden; Check: WasRunning

[Code]
var
  WasRunningFlag: Boolean;
  PreselectDone: Boolean;
  AutostartUnticked: Boolean;

function WasRunning(): Boolean;
begin
  Result := WasRunningFlag;
end;

function SetEnvironmentVariable(lpName: String; lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function RunValueData(var Data: String): Boolean;
begin
  Result := RegQueryStringValue(HKCU, '{#RunKey}', '{#RunValueName}', Data);
end;

function StartupCommand(): String;
begin
  Result := 'wscript.exe "' + ExpandConstant('{app}') + '\Claude-Notifier.vbs"';   // exactly what the application itself writes
end;

function PointsToThisInstall(const Data: String): Boolean;
begin
  Result := Pos(Lowercase(ExpandConstant('{app}')) + '\', Lowercase(Data)) > 0;
end;

{ stops this installation's processes: 0 = none running, 10 = stopped, anything else = could not stop }
function StopInstalledApp(): Integer;
var
  Code: Integer;
begin
  SetEnvironmentVariable('CN_APPDIR', ExpandConstant('{app}'));
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
       '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {#StopB64}', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Data: String;
begin
  { an existing startup entry means the user wanted it: it is shown ticked on upgrade (once); for a new installation it stays opt-in }
  if (CurPageID = wpSelectTasks) and (not PreselectDone) then
  begin
    PreselectDone := True;
    if RunValueData(Data) then WizardSelectTasks('autostart');
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Data: String;
begin
  Result := True;
  { only a deliberate un-tick on the task page removes an existing entry; a silent install never removes it }
  if CurPageID = wpSelectTasks then
    AutostartUnticked := RunValueData(Data) and (not WizardIsTaskSelected('autostart'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  Code := StopInstalledApp();
  WasRunningFlag := (Code = 10);
  if (Code <> 0) and (Code <> 10) then
    Result := 'Claude Notifier is running and could not be closed automatically.' + #13#10#13#10 +
              'Please choose "Exit" from its icon in the notification area (next to the clock), then run Setup again.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Data: String;
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('autostart') then
      RegWriteStringValue(HKCU, '{#RunKey}', '{#RunValueName}', StartupCommand())          { one value, overwritten in place: never a duplicate }
    else if AutostartUnticked and RunValueData(Data) and PointsToThisInstall(Data) then
      RegDeleteValue(HKCU, '{#RunKey}', '{#RunValueName}');                              { the user un-ticked it }
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopInstalledApp();
    if RunValueData(Data) and PointsToThisInstall(Data) then RegDeleteValue(HKCU, '{#RunKey}', '{#RunValueName}');
    RegDeleteKeyIncludingSubkeys(HKCU, '{#AumidKey}');                                    { the toast identity the application registered }
  end;
  if (CurUninstallStep = usDone) and (not UninstallSilent) then
    MsgBox('{#AppName} was removed.' + #13#10#13#10 +
           'Your settings, appearance, phone setup and history were NOT deleted. They are in:' + #13#10 +
           GetEnv('USERPROFILE') + '\.claude-notifier' + #13#10#13#10 +
           'You can delete that folder yourself if you no longer need it.', mbInformation, MB_OK);
end;
