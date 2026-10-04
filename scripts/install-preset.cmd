@echo off
rem install-preset.cmd — thin launcher for scripts\install-preset.js
rem Materializes the `recursive` agent preset into %DSH_HOME%\.agent-presets\recursive\
rem with an absolute file-URL row into the profile-installed package.
setlocal
node "%~dp0install-preset.js" %*
exit /b %ERRORLEVEL%
