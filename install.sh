#!/usr/bin/env bash
set -euo pipefail

# loukanikode installer
# Usage: curl -fsSL https://raw.githubusercontent.com/loukaniko85/loukanikode/main/install.sh | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="https://github.com/loukaniko85/loukanikode.git"
INSTALL_DIR="$HOME/.local/share/loukanikode"
BUN_MIN_VERSION="1.3.11"

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*"; exit 1; }

header() {
  echo ""
  printf "${BOLD}${CYAN}"
  cat << 'ART'
   ___                            _
  / _|_ __ ___  ___        ___ __| | ___
 | |_| '__/ _ \/ _ \_____ / __/ _` |/ _ \
 |  _| | |  __/  __/_____| (_| (_| |  __/
 |_| |_|  \___|\___|      \___\__,_|\___|

ART
  printf "${RESET}"
   printf "${DIM}  The free build of Claude Code — 100% offline with llama.cpp${RESET}\n"
  echo ""
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

check_os() {
  case "$(uname -s)" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)      fail "Unsupported OS: $(uname -s). macOS or Linux required." ;;
  esac
  ok "OS: $(uname -s) $(uname -m)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    fail "git is not installed. Install it first:
    macOS:  xcode-select --install
    Linux:  sudo apt install git  (or your distro's equivalent)"
  fi
  ok "git: $(git --version | head -1)"
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required. Upgrading..."
  else
    info "bun not found. Installing..."
  fi
  install_bun
}

install_bun() {
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is on PATH for this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation succeeded but binary not found on PATH.
    Add this to your shell profile and restart:
      export PATH=\"\$HOME/.bun/bin:\$PATH\""
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Clone & build
# -------------------------------------------------------------------

clone_repo() {
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists"
    if [ -d "$INSTALL_DIR/.git" ]; then
      info "Pulling latest changes..."
      git -C "$INSTALL_DIR" pull --ff-only origin main 2>/dev/null || {
        warn "Pull failed, continuing with existing copy"
      }
    fi
  else
    info "Cloning repository..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
  ok "Source: $INSTALL_DIR"
}

install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_binary() {
  info "Building loukanikode..."
  cd "$INSTALL_DIR"
  bun run build
  if [ ! -f "$INSTALL_DIR/cli" ]; then
    fail "Build failed: $INSTALL_DIR/cli not found"
  fi
  cp "$INSTALL_DIR/cli" "$INSTALL_DIR/loukanikode"
  chmod +x "$INSTALL_DIR/loukanikode"
  ok "Binary built: $INSTALL_DIR/loukanikode"
}

link_binary() {
  local link_dir="$HOME/.local/bin"
  mkdir -p "$link_dir"

  ln -sf "$INSTALL_DIR/loukanikode" "$link_dir/loukanikode"
  ok "Symlinked: $link_dir/loukanikode"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$link_dir"; then
    warn "$link_dir is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
}

configure_llama() {
  local llama_server=""
  local llama_model=""

  echo ""
  info "Llama.cpp Configuration"
  printf "  ${DIM}loukanikode needs to know where your llama.cpp server is running.${RESET}\n"
  echo ""

  if [ -t 0 ]; then
    # Interactive mode - prompt user
    printf "  ${BOLD}Llama.cpp server URL${RESET} ${DIM}(e.g. http://localhost:8080/v1)${RESET}\n"
    printf "  ${CYAN}>${RESET} "
    read -r llama_server
    echo ""

    printf "  ${BOLD}Model name${RESET} ${DIM}(e.g. llama-3-8b-Q4_K_M.gguf)${RESET}\n"
    printf "  ${CYAN}>${RESET} "
    read -r llama_model
    echo ""
  else
    # Non-interactive (curl | bash) - use defaults and show instructions
    warn "Non-interactive install detected. Using defaults."
    llama_server="http://localhost:8080/v1"
    llama_model="local-llama"
  fi

  # Set defaults if empty
  if [ -z "$llama_server" ]; then
    llama_server="http://localhost:8080/v1"
  fi
  if [ -z "$llama_model" ]; then
    llama_model="local-llama"
  fi

  # Create .env in install dir
  cat > "$INSTALL_DIR/.env" << EOF
# Local Llama.cpp Configuration
# Generated by loukanikode installer

# Server URL (http://host:port/v1 for OpenAI-compatible endpoint)
LLAMA_CPP_SERVER=${llama_server}

# Model file name
LLAMA_CPP_MODEL=${llama_model}

# Explicitly enable llama mode
LOUKANIKODE_USE_LLAMA=1

# Optional: API key for llama server (if your server requires authentication)
# LLAMA_API_KEY=your-api-key-here

# Optional: Custom timeout in milliseconds
# LLAMA_TIMEOUT_MS=300000

# Disable attribution header for better KV cache hit rates with local models
LOUKANIKODE_ATTRIBUTION_HEADER=0

# Disable telemetry
LOUKANIKODE_ENABLE_TELEMETRY=0
EOF

  chmod 600 "$INSTALL_DIR/.env"
  ok "Created: $INSTALL_DIR/.env"

  # Also create config directory and copy .env there for cli.tsx loader
  local config_dir="$HOME/.loukanikode"
  mkdir -p "$config_dir"
  cp "$INSTALL_DIR/.env" "$config_dir/.env"
  ok "Created: $config_dir/.env"

  if [ ! -t 0 ]; then
    echo ""
    warn "You installed via pipe (curl | bash). Please edit your config:"
    printf "  ${CYAN}nano ~/.loukanikode/.env${RESET}\n"
    echo ""
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

header
info "Starting installation..."
echo ""

check_os
check_git
check_bun
echo ""

clone_repo
install_deps
build_binary
link_binary
configure_llama

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}loukanikode${RESET}                          # interactive REPL\n"
printf "    ${CYAN}loukanikode -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Configuration:${RESET}\n"
printf "    ${DIM}Install dir:${RESET} ${CYAN}$INSTALL_DIR/.env${RESET}\n"
printf "    ${DIM}Config dir: ${RESET} ${CYAN}~/.loukanikode/.env${RESET}\n"
echo ""
printf "  ${DIM}Source: $INSTALL_DIR${RESET}\n"
printf "  ${DIM}Binary: $INSTALL_DIR/loukanikode${RESET}\n"
printf "  ${DIM}Link:   ~/.local/bin/loukanikode${RESET}\n"
echo ""
