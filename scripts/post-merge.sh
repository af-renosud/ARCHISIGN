#!/bin/bash
set -e
npm install
npm run db:push
./scripts/run-node-tests.sh
