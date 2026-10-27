#!/bin/sh
exec node "$(dirname "$0")/mock-muse.mjs" "$@"
