#!/usr/bin/env bash
# Clipment agent 설치 스크립트 (macOS). 여러 번 실행해도 안전합니다.
#   ./install.sh [--yes] [--update] [--uninstall] [--help]
#   기본은 GitHub 최신 릴리스 tarball(gh 로그인 시)을 설치하고, gh 가 없으면 git clone 으로 대체합니다.
#   --update: 질문 없이 코어(소스·의존성·링크)만 최신으로 갱신 (clipment update 가 사용)
# 환경변수:
#   CLIPMENT_REPO         저장소 (기본 street567/clipment-agent, URL/경로도 가능)
#   CLIPMENT_VERSION      설치할 릴리스 태그 (예: v0.1.0, 기본 latest)
#   CLIPMENT_DIR          설치 위치 (기본 ~/.clipment/agent)
#   CLIPMENT_MARKETPLACE  Claude Code 마켓플레이스 소스 (기본 street567/clipment-agent)
#   CLIPMENT_ASSUME_NO=1  모든 질문에 n (테스트용)
set -euo pipefail

REPO="${CLIPMENT_REPO:-street567/clipment-agent}"
DIR="${CLIPMENT_DIR:-$HOME/.clipment/agent}"
MARKETPLACE_SRC="${CLIPMENT_MARKETPLACE:-street567/clipment-agent}"
MARKETPLACE_NAME="clipment-agent"
VERSION="${CLIPMENT_VERSION:-latest}"
DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
BIN_DIR="$HOME/.local/bin"
ICLOUD_WS="$HOME/Library/Mobile Documents/com~apple~CloudDocs/ClipReview"
ASSUME_YES=0
UNINSTALL=0
UPDATE=0

say()  { printf '%s\n' "$*"; }
warn() { printf '경고: %s\n' "$*" >&2; }
die()  { printf '오류: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --update) UPDATE=1; ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "알 수 없는 옵션: $arg (--help 참고)" ;;
  esac
done

# 질문: y 면 0, 아니면 1. 대화 불가(TTY 없음)면 기본 n.
HAVE_TTY=0
if [ -t 0 ]; then HAVE_TTY=1; elif { : </dev/tty; } 2>/dev/null; then HAVE_TTY=2; fi

ask() {
  local prompt="$1" ans=""
  if [ "$ASSUME_YES" = 1 ]; then say "$prompt [y/N] y (--yes)"; return 0; fi
  if [ "${CLIPMENT_ASSUME_NO:-}" = 1 ]; then say "$prompt [y/N] n (CLIPMENT_ASSUME_NO)"; return 1; fi
  case "$HAVE_TTY" in
    1) read -r -p "$prompt [y/N] " ans || ans="" ;;
    2) read -r -p "$prompt [y/N] " ans </dev/tty || ans="" ;;
    *) say "$prompt [y/N] n (대화형 터미널 아님)"; return 1 ;;
  esac
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

[ "$(uname -s)" = Darwin ] || die "macOS 전용입니다."

# 로컬 체크아웃에서 실행했는지 (curl | bash 면 BASH_SOURCE 가 파일이 아님)
LOCAL_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  _d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$_d/package.json" ] && grep -q '"clipment-agent"' "$_d/package.json"; then LOCAL_DIR="$_d"; fi
fi

# 링크가 우리 설치를 가리키는지
points_to_ours() {
  local link="$1" t
  [ -L "$link" ] || return 1
  t="$(readlink "$link")"
  case "$t" in
    "$DIR"/*) return 0 ;;
    *) [ -n "$LOCAL_DIR" ] && case "$t" in "$LOCAL_DIR"/*) return 0 ;; esac ;;
  esac
  return 1
}

# ---------------------------------------------------------------- 제거
if [ "$UNINSTALL" = 1 ]; then
  UNI_APP="${LOCAL_DIR:-$DIR}"
  if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
    if [ -f "$UNI_APP/src/cli.ts" ] && { [ -f "$HOME/Library/LaunchAgents/com.street567.clipment.daemon.plist" ] || [ -f "$HOME/.clipment/daemon.lock" ]; }; then
      say "백그라운드 데몬 제거 (LaunchAgent + 실행 중인 프로세스)"
      bun "$UNI_APP/src/cli.ts" daemon uninstall --kill-orphans || warn "데몬 제거 실패"
    fi
    if [ -f "$UNI_APP/scripts/desktop-config.ts" ] && [ -f "$DESKTOP_CFG" ] && grep -q '"clipment"' "$DESKTOP_CFG"; then
      bun "$UNI_APP/scripts/desktop-config.ts" remove "$DESKTOP_CFG" clipment || warn "Claude 데스크톱 설정에서 clipment 제거 실패"
    fi
  else
    warn "bun 이 없어 데몬/Claude 데스크톱 설정 제거를 건너뜁니다."
  fi
  for n in clipment cliprev; do
    if points_to_ours "$BIN_DIR/$n"; then rm "$BIN_DIR/$n"; say "링크 제거: $BIN_DIR/$n"
    elif [ -e "$BIN_DIR/$n" ] || [ -L "$BIN_DIR/$n" ]; then warn "$BIN_DIR/$n 은 이 설치의 링크가 아니라 그대로 둡니다."; fi
  done
  if [ -d "$DIR" ]; then
    # 안전장치: 비어 있지 않은 임의 폴더를 지우지 않도록 clipment-agent 인지 확인
    if [ -f "$DIR/package.json" ] && grep -q '"clipment-agent"' "$DIR/package.json"; then
      rm -rf "$DIR"; say "삭제: $DIR"
    else
      warn "$DIR 은 clipment-agent 설치가 아닌 것 같아 지우지 않습니다."
    fi
  fi
  if command -v claude >/dev/null 2>&1; then
    if ask "Claude Code 플러그인(clipment@$MARKETPLACE_NAME)과 마켓플레이스를 제거할까요?"; then
      claude plugin uninstall "clipment@$MARKETPLACE_NAME" || warn "플러그인 제거 실패(설치 안 됐을 수 있음)"
      claude plugin marketplace remove "$MARKETPLACE_NAME" || warn "마켓플레이스 제거 실패(등록 안 됐을 수 있음)"
    else
      say "직접 제거: claude plugin uninstall clipment@$MARKETPLACE_NAME && claude plugin marketplace remove $MARKETPLACE_NAME"
    fi
  fi
  if command -v codex >/dev/null 2>&1; then
    if ask "Codex MCP 서버 'clipment' 를 제거할까요?"; then
      codex mcp remove clipment || warn "codex MCP 제거 실패(등록 안 됐을 수 있음)"
    else
      say "직접 제거: codex mcp remove clipment"
    fi
  fi
  say "워크스페이스 설정(~/.config/cliprev/workspaces.json)과 영상/프로젝트 폴더는 건드리지 않았습니다."
  say "워크스페이스 등록만 풀려면: clipment workspaces remove <이름> (설치 제거 전에 실행)"
  exit 0
fi

# ---------------------------------------------------------------- 의존성
export PATH="$HOME/.bun/bin:$PATH"
missing_pkgs=()
command -v bun >/dev/null 2>&1 || missing_pkgs+=("oven-sh/bun/bun")
command -v ffmpeg >/dev/null 2>&1 || missing_pkgs+=("ffmpeg")
command -v git >/dev/null 2>&1 || { [ -n "$LOCAL_DIR" ] || die "git 이 필요합니다. xcode-select --install"; }

if [ "${#missing_pkgs[@]}" -gt 0 ]; then
  say "필요한 도구가 없습니다: ${missing_pkgs[*]}"
  if command -v brew >/dev/null 2>&1; then
    say "다음을 실행합니다: brew install ${missing_pkgs[*]}"
    if ask "Homebrew 로 설치할까요?"; then
      brew install "${missing_pkgs[@]}"
    else
      say "직접 설치 후 다시 실행하세요: brew install ${missing_pkgs[*]}"
      exit 1
    fi
  else
    say "Homebrew 가 없습니다. https://brew.sh 설치 후: brew install ${missing_pkgs[*]}"
    exit 1
  fi
  command -v bun >/dev/null 2>&1 || die "bun 설치 후에도 PATH 에서 찾지 못했습니다. 새 터미널에서 다시 실행하세요."
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg 를 찾지 못했습니다."
fi
BUN_BIN="$(command -v bun)"

# ---------------------------------------------------------------- 소스
# 릴리스 tarball 설치 (gh 로그인 필요). 성공 0, 사용 불가/실패 1.
release_install() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 || return 1
  case "$REPO" in */*) ;; *) return 1 ;; esac
  [ ! -e "$REPO" ] || return 1
  case "$REPO" in *:*) return 1 ;; esac
  local tmp tag=()
  tmp="$(mktemp -d)"
  [ "$VERSION" = latest ] || tag=("$VERSION")
  if ! gh release download ${tag[@]+"${tag[@]}"} --repo "$REPO" --pattern 'clipment-agent-*.tar.gz' --dir "$tmp" >/dev/null 2>&1; then
    rm -rf "$tmp"; return 1
  fi
  if ! tar -xzf "$tmp"/clipment-agent-*.tar.gz -C "$tmp" || [ ! -f "$tmp/clipment-agent/package.json" ]; then
    rm -rf "$tmp"; return 1
  fi
  if [ -e "$APP" ]; then
    # 안전장치: clipment-agent 설치(또는 빈 폴더)만 교체
    if [ -f "$APP/package.json" ] && grep -q '"clipment-agent"' "$APP/package.json"; then rm -rf "$APP"
    elif [ -z "$(ls -A "$APP" 2>/dev/null)" ]; then rmdir "$APP"
    else rm -rf "$tmp"; die "$APP 이(가) 이미 있고 clipment-agent 설치가 아닙니다. 옮기거나 지운 뒤 다시 실행하세요."; fi
  fi
  mkdir -p "$(dirname "$APP")"
  mv "$tmp/clipment-agent" "$APP"
  rm -rf "$tmp"
  say "릴리스 설치: $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP/package.json" | head -1) -> $APP"
}

if [ -n "$LOCAL_DIR" ]; then
  APP="$LOCAL_DIR"
  say "로컬 체크아웃 사용: $APP"
else
  APP="$DIR"
  if [ -d "$APP/.git" ]; then
    say "업데이트(git): $APP"
    if [ "$VERSION" = latest ]; then git -C "$APP" pull --ff-only
    else git -C "$APP" fetch --tags && git -C "$APP" checkout "$VERSION"; fi
  elif release_install; then
    :
  else
    [ "$UPDATE" = 0 ] || die "릴리스 다운로드에 실패했습니다 (gh auth status, 네트워크, CLIPMENT_VERSION=$VERSION 확인)."
    [ ! -e "$APP" ] || [ -z "$(ls -A "$APP" 2>/dev/null)" ] || die "$APP 이(가) 이미 있고 git 저장소가 아닙니다. 옮기거나 지운 뒤 다시 실행하세요."
    say "릴리스를 받지 못해 git clone 으로 대체합니다 (gh 로그인하면 릴리스 설치)."
    mkdir -p "$(dirname "$APP")"
    say "clone: $REPO -> $APP"
    case "$REPO" in
      */*) if [ -e "$REPO" ] || [[ "$REPO" == *:* ]]; then
             git clone "$REPO" "$APP"
           elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
             gh repo clone "$REPO" "$APP"
           else
             git clone "https://github.com/$REPO.git" "$APP"
           fi
           [ "$VERSION" = latest ] || git -C "$APP" checkout "$VERSION" ;;
      *) die "CLIPMENT_REPO 형식을 알 수 없습니다: $REPO" ;;
    esac
  fi
fi

say "의존성 설치: bun install --production"
(cd "$APP" && bun install --production --no-summary)

# ---------------------------------------------------------------- 링크
chmod +x "$APP/src/cli.ts" "$APP/src/mcp.ts" 2>/dev/null || true
mkdir -p "$BIN_DIR"
for n in clipment cliprev; do
  target="$BIN_DIR/$n"
  if [ -e "$target" ] && ! [ -L "$target" ]; then warn "$target 은 일반 파일이라 덮어쓰지 않습니다."; continue; fi
  ln -sfn "$APP/src/cli.ts" "$target"
  say "링크: $target -> $APP/src/cli.ts"
done
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR 이 PATH 에 없습니다. ~/.zshrc 에 추가하세요: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
CLIPMENT="$BIN_DIR/clipment"

if [ "$UPDATE" = 1 ]; then
  say "업데이트 완료 (실행 중인 세션은 그대로입니다. 새 세션부터 새 버전을 씁니다)."
  exit 0
fi

# ---------------------------------------------------------------- Claude Code
if command -v claude >/dev/null 2>&1; then
  if ask "Claude Code 플러그인을 설치할까요? (마켓플레이스 $MARKETPLACE_SRC)"; then
    claude plugin marketplace add "$MARKETPLACE_SRC" || warn "마켓플레이스 추가 실패(이미 등록됐을 수 있음)"
    claude plugin install "clipment@$MARKETPLACE_NAME" || warn "플러그인 설치 실패"
  else
    say "나중에: claude plugin marketplace add $MARKETPLACE_SRC && claude plugin install clipment@$MARKETPLACE_NAME"
  fi
fi

# ---------------------------------------------------------------- Codex
if command -v codex >/dev/null 2>&1; then
  if ask "Codex 에 MCP 서버 'clipment' 를 등록할까요?"; then
    codex mcp remove clipment >/dev/null 2>&1 || true
    codex mcp add clipment --env CLIPREV_AGENT=codex -- "$BUN_BIN" "$APP/src/mcp.ts" || warn "codex MCP 등록 실패"
    say "참고: Codex 앱도 같은 ~/.codex/config.toml 을 쓰므로 별도 등록이 필요 없습니다."
  else
    say "나중에: codex mcp add clipment --env CLIPREV_AGENT=codex -- $BUN_BIN $APP/src/mcp.ts"
  fi
fi

# ---------------------------------------------------------------- Claude 데스크톱 (채팅)
if [ -d "$(dirname "$DESKTOP_CFG")" ]; then
  if ask "Claude 데스크톱(채팅)에 MCP 서버 'clipment' 를 등록할까요? (기존 설정은 백업, 다른 서버는 그대로. 확장 .mcpb 를 쓰면 필요 없음)"; then
    "$BUN_BIN" "$APP/scripts/desktop-config.ts" add "$DESKTOP_CFG" clipment "$BUN_BIN" "$APP/src/mcp.ts" || warn "Claude 데스크톱 설정 등록 실패"
    say "Claude 데스크톱을 완전히 종료 후 다시 실행하세요. 데스크톱 채팅은 셸이 없어 편집/렌더는 못 하고 코멘트 확인·답글·게시·정리만 가능합니다."
  fi
fi

# ---------------------------------------------------------------- 워크스페이스
WS_CONFIG="${CLIPREV_CONFIG:-$HOME/.config/cliprev/workspaces.json}"
registered="$(cat "$WS_CONFIG" 2>/dev/null || true)"
if [ -d "$ICLOUD_WS" ]; then
  if printf '%s' "$registered" | grep -qF "$ICLOUD_WS"; then
    say "iCloud 워크스페이스는 이미 설정 파일에 등록돼 있습니다."
  elif ask "iCloud ClipReview 폴더를 워크스페이스로 등록할까요? ($ICLOUD_WS)"; then
    "$CLIPMENT" workspaces add "$ICLOUD_WS" --name icloud || warn "iCloud 워크스페이스 등록 실패"
  fi
fi
if ask "Google Drive 데스크톱 폴더를 감지해 워크스페이스로 등록할까요?"; then
  "$CLIPMENT" workspaces add --google || warn "Google Drive 등록 실패(감지 실패 또는 이미 등록). 'clipment workspaces add --google --help' 는 README 참고"
fi

# ---------------------------------------------------------------- 데몬
if ask "백그라운드 데몬(새 요청 알림·인덱스 자동 갱신)을 LaunchAgent 로 설치할까요? (sudo 불필요)"; then
  "$BUN_BIN" "$APP/src/cli.ts" daemon install --kill-orphans || warn "데몬 설치 실패"
  if [ "$ASSUME_YES" = 1 ]; then
    say "자동 처리는 꺼 둡니다(off). 켜려면: clipment daemon config --auto-run claude|codex"
  elif ask "새 요청이 오면 자동으로 처리(claude/codex 를 백그라운드 실행)까지 켤까요? 기본은 알림만(off)입니다."; then
    if command -v claude >/dev/null 2>&1 && ask "  claude 로 자동 처리할까요? (아니면 codex 선택)"; then
      "$BUN_BIN" "$APP/src/cli.ts" daemon config --auto-run claude >/dev/null
    elif command -v codex >/dev/null 2>&1 && ask "  codex 로 자동 처리할까요?"; then
      "$BUN_BIN" "$APP/src/cli.ts" daemon config --auto-run codex >/dev/null
    else
      say "  자동 처리는 끈 상태(off)로 둡니다."
    fi
  fi
  say "상태: clipment daemon status / 로그: clipment daemon logs"
fi

say ""
say "설치 완료. 확인: clipment workspaces  (업데이트: clipment update)"
exit 0
