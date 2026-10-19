#!/bin/bash
cd /e/agent/fatfish-pet
cmd //c dev.bat > dev.log 2>&1 &
echo $! > .dev.pid
