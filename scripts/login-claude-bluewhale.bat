@echo off
setlocal

set "CLAUDE_PROFILE=%USERPROFILE%\.claude\playwright-profile"
set "TARGET_URL=https://shengji.lingdongsz.com/uranus/#/afterMessage/salesConsultation"

echo Opening Claude browser profile for Blue Whale login...
echo.
echo 1. Log in to Blue Whale in the Chrome window that opens.
echo 2. Confirm the after-sales page is visible.
echo 3. Close that Chrome window after login, then keep the local listener running.
echo.

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%CLAUDE_PROFILE%" "%TARGET_URL%"

endlocal
