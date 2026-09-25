@echo off
cd /d "%~dp0"
start "" http://localhost:8750
python hub\hub.py
