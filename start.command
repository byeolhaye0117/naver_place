#!/bin/bash
# 맥에서 더블클릭으로 실행하는 파일입니다.
# 처음 한 번은 마우스 오른쪽 클릭 → 열기 를 눌러야 할 수 있습니다.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js 가 설치되어 있지 않습니다."
  echo "  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  echo ""
  read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다..."
  exit 1
fi

PORT="${PORT:-5173}"

# 서버가 뜬 뒤 브라우저를 연다
( for _ in $(seq 1 40); do
    if curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
      open "http://localhost:$PORT"; break
    fi
    sleep 0.25
  done ) &

node server.js
