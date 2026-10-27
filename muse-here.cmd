@echo off
rem Muse Dashboard - muse-here.cmd
rem Author: Adam S. Barnett
rem
rem Muse Code in a terminal with the same quality settings as the dashboard:
rem no approval prompts (the OS sandbox stays on), Muse's own background
rem checkers on, tool output kept in context, compaction sized for ~256k tokens.
rem The execution policy reaches the model through each project's AGENTS.md.
rem Sessions started here also appear in the dashboard's sidebar.
rem Usage: muse-here [folder]   (never starts in C:\Windows\System32)
setlocal
if not "%~1"=="" cd /d "%~1"
if /i "%CD%"=="%SystemRoot%\System32" cd /d "%~dp0Projects"
call muse --approval-mode never --approval-judge off -c context_compaction.tool_result_clearing_enabled=false -c context_compaction.provider_context_limit_tokens=256000
