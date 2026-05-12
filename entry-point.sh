#!/bin/sh
set -e

cd "${WORKDIR}"
# shellcheck disable=SC1091
. ./.env

cd "${TARGET_DIR}"

echo "${FUNCTION_API_SPEC}" > openapi.json

kdex-fnnodejsgen --spec openapi.json --target .

npm install --no-audit --no-fund
npx tsc --noEmit

tree .
