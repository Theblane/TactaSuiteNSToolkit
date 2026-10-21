@echo off
REM NetSuite TactaSuite - start the Bedrock token helper with the default profile.
REM Edit AWS_PROFILE / AWS_REGION below if your Bedrock access lives elsewhere.
set AWS_PROFILE=aws-code-ai
set AWS_REGION=us-east-1
cd /d "%~dp0"
if not exist node_modules (npm install)
npm start
