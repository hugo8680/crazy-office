set -eu
model_root=/opt/office.laisengou.com/model
model_runtime="$model_root/runtime-v0.40.6"
test -x "$model_runtime/bin/ollama"
if ! getent passwd office-model >/dev/null; then
  useradd --system --user-group --home-dir "$model_root/home" --shell /sbin/nologin office-model
fi
install -d -o office-model -g office-model -m 700 "$model_root/home"
chown -R office-model:office-model "$model_root/models"
chmod 750 "$model_root/models"
if [ -f /etc/systemd/system/office-model.service ]; then
  if ! grep -q 'Description=Crazy Office private local model' /etc/systemd/system/office-model.service; then
    printf 'Refusing to replace an unrelated office-model.service\n' >&2
    exit 1
  fi
fi
cat > /etc/systemd/system/office-model.service <<'UNIT'
[Unit]
Description=Crazy Office private local model
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=office-model
Group=office-model
WorkingDirectory=/opt/office.laisengou.com/model
ExecStart=/opt/office.laisengou.com/model/runtime-v0.40.6/bin/ollama serve
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=/opt/office.laisengou.com/model/models"
Environment="OLLAMA_NO_CLOUD=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_CONTEXT_LENGTH=8192"
Environment="OLLAMA_KEEP_ALIVE=15m"
Environment="OLLAMA_LOAD_TIMEOUT=5m"
Environment="LLAMA_ARG_CACHE_RAM=512"
UnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
CPUQuota=600%
MemoryMax=10G
TasksMax=128
Nice=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/office.laisengou.com/model/home /opt/office.laisengou.com/model/models
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now office-model.service
systemctl is-active office-model.service
ss -lntp | grep ':11434'
