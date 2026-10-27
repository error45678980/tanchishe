@echo off
chcp 65001 >nul
title 贪吃蛇数据库隧道 (localhost:15432 -^> 服务器 127.0.0.1:5432)
echo.
echo   正在建立 SSH 隧道：localhost:15432  ==^>  123.56.70.43:5432
echo   这个窗口别关，关了本地就连不上数据库了。
echo.
:loop
ssh -N tanchishe
echo.
echo   [%date% %time%] 隧道断开，5 秒后重连...
timeout /t 5 /nobreak >nul
goto loop
