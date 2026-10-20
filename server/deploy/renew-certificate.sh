#!/bin/sh
set -eu
/usr/bin/certbot renew --quiet --cert-name office.laisengou.com \
  --config-dir /opt/office.laisengou.com/tls/config \
  --work-dir /opt/office.laisengou.com/tls/work \
  --logs-dir /opt/office.laisengou.com/tls/logs \
  --deploy-hook '/usr/sbin/nginx -t && /usr/sbin/nginx -s reload'
