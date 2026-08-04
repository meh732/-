#!/usr/bin/env bash

# ======================================================
# Inventory Bot & Userbot Installer (Sanaei Style)
# Repository: https://github.com/meh732/-.git
# ======================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

INSTALL_DIR="/opt/inventory-bot"
SERVICE_NAME="inventory-bot"
REPO_URL="https://github.com/meh732/-.git"

show_banner() {
    clear
    echo -e "${CYAN}======================================================${NC}"
    echo -e "${GREEN}    ___                      _                      ${NC}"
    echo -e "${GREEN}   |_ _|_ ____   _____ _ __ | |_ ___  _ __ _   _    ${NC}"
    echo -e "${GREEN}    | || '_ \ \ / / _ \ '_ \| __/ _ \| '__| | | |   ${NC}"
    echo -e "${GREEN}    | || | | \ V /  __/ | | | || (_) | |  | |_| |   ${NC}"
    echo -e "${GREEN}   |___|_| |_|\_/ \___|_| |_|\__\___/|_|   \__, |   ${NC}"
    echo -e "${GREEN}                                           |___/    ${NC}"
    echo -e "${CYAN}        Inventory & Telegram Userbot Installer        ${NC}"
    echo -e "${CYAN}======================================================${NC}"
    echo ""
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}[ERROR] Please run this script as root (sudo).${NC}"
        exit 1
    fi
}

install_dependencies() {
    echo -e "${BLUE}[1/5] Updating OS packages and installing prerequisites...${NC}"
    if command -v apt-get &> /dev/null; then
        apt-get update -y
        apt-get install -y curl git build-essential ufw
    elif command -v yum &> /dev/null; then
        yum update -y
        yum install -y curl git make gcc-c++
    fi

    # Install Node.js 20.x
    if ! command -v node &> /dev/null || [ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 18 ]; then
        echo -e "${BLUE}Installing Node.js 20.x LTS...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        if command -v apt-get &> /dev/null; then
            apt-get install -y nodejs
        else
            yum install -y nodejs
        fi
    fi

    echo -e "${GREEN}Node.js Version: $(node -v)${NC}"
    echo -e "${GREEN}NPM Version: $(npm -v)${NC}"
}

clone_or_update_repo() {
    echo -e "${BLUE}[2/5] Downloading latest code from GitHub...${NC}"
    if [ -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}Existing directory found at $INSTALL_DIR. Updating code...${NC}"
        cd "$INSTALL_DIR"
        git fetch --all
        git reset --hard origin/main || git reset --hard origin/master || true
        git pull || true
    else
        mkdir -p "$INSTALL_DIR"
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
}

build_app() {
    echo -e "${BLUE}[3/5] Installing NPM dependencies and building...${NC}"
    cd "$INSTALL_DIR"
    npm install
    npm run build
}

configure_env_and_service() {
    echo -e "${BLUE}[4/5] Configuring environment & systemd background service...${NC}"
    
    cd "$INSTALL_DIR"

    # Default values
    DEFAULT_PORT="3000"
    
    if [ -f "$INSTALL_DIR/.env" ]; then
        source "$INSTALL_DIR/.env" || true
    fi

    echo -e "${CYAN}------------------------------------------------------${NC}"
    read -p "Enter Port for Web UI/Server [Default: ${PORT:-3000}]: " INPUT_PORT
    APP_PORT=${INPUT_PORT:-${PORT:-3000}}

    read -p "Enter Telegram Bot Token (Optional, press Enter to skip): " INPUT_TOKEN
    BOT_TOKEN=${INPUT_TOKEN:-${BOT_TOKEN:-""}}

    read -p "Enter Admin Telegram User ID (Optional, press Enter to skip): " INPUT_ADMIN
    ADMIN_ID=${INPUT_ADMIN:-${ADMIN_ID:-""}}

    cat <<EOF > "$INSTALL_DIR/.env"
PORT=$APP_PORT
BOT_TOKEN=$BOT_TOKEN
ADMIN_ID=$ADMIN_ID
NODE_ENV=production
EOF

    # Create systemd service
    cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=Inventory Telegram Bot & Userbot Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/dist/server.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME}
    systemctl restart ${SERVICE_NAME}

    # Symlink manager shortcut command
    ln -sf "$INSTALL_DIR/install.sh" /usr/local/bin/inventory-bot
    chmod +x /usr/local/bin/inventory-bot || true

    echo -e "${GREEN}[SUCCESS] Service ${SERVICE_NAME} started successfully!${NC}"
}

show_complete() {
    IP_ADDR=$(curl -s https://api.ipify.org || hostname -I | awk '{print $1}')
    echo -e "\n${CYAN}======================================================${NC}"
    echo -e "${GREEN} 🎉 Installation Complete! / نصب با موفقیت انجام شد ${NC}"
    echo -e "${CYAN}======================================================${NC}"
    echo -e " 🌐 Web Panel URL: ${YELLOW}http://${IP_ADDR}:${APP_PORT}${NC}"
    echo -e " 🛠️  Management CLI: Type ${GREEN}inventory-bot${NC} anywhere in terminal"
    echo -e "${CYAN}======================================================${NC}\n"
}

manage_menu() {
    show_banner
    echo -e "${YELLOW}Please select an option / یک گزینه را انتخاب کنید:${NC}\n"
    echo -e " ${GREEN}1)${NC} Full Install / Reinstall (نصب کامل یا نصب مجدد)"
    echo -e " ${GREEN}2)${NC} Update Bot from GitHub (آپدیت به آخرین نسخه گیت‌هاب)"
    echo -e " ${GREEN}3)${NC} Restart Service (ریستارت سرویس)"
    echo -e " ${GREEN}4)${NC} Check Service Status (مشاهده وضعیت سرویس)"
    echo -e " ${GREEN}5)${NC} View Live Logs (مشاهده لاگ‌های زنده)"
    echo -e " ${GREEN}6)${NC} Change Port or Environment Variables (تغییر پورت و تنظیمات)"
    echo -e " ${RED}7)${NC} Uninstall (حذف کامل از سرور)"
    echo -e " ${CYAN}0)${NC} Exit (خروج)"
    echo ""
    read -p "Select [0-7]: " CHOICE

    case $CHOICE in
        1)
            check_root
            install_dependencies
            clone_or_update_repo
            build_app
            configure_env_and_service
            show_complete
            ;;
        2)
            check_root
            clone_or_update_repo
            build_app
            systemctl restart ${SERVICE_NAME}
            echo -e "${GREEN}Updated and restarted successfully!${NC}"
            ;;
        3)
            check_root
            systemctl restart ${SERVICE_NAME}
            echo -e "${GREEN}Service restarted.${NC}"
            ;;
        4)
            systemctl status ${SERVICE_NAME} --no-pager
            ;;
        5)
            journalctl -u ${SERVICE_NAME} -n 100 -f
            ;;
        6)
            check_root
            configure_env_and_service
            ;;
        7)
            check_root
            systemctl stop ${SERVICE_NAME} || true
            systemctl disable ${SERVICE_NAME} || true
            rm -f /etc/systemd/system/${SERVICE_NAME}.service
            rm -rf "$INSTALL_DIR"
            rm -f /usr/local/bin/inventory-bot
            systemctl daemon-reload
            echo -e "${RED}Uninstalled successfully.${NC}"
            ;;
        0)
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid selection.${NC}"
            ;;
    esac
}

# If run directly from terminal without args, launch menu
if [ "$1" == "install" ]; then
    check_root
    install_dependencies
    clone_or_update_repo
    build_app
    configure_env_and_service
    show_complete
else
    manage_menu
fi
