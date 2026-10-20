FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
RUN npm run check && npm run build

FROM nginx:1.28-alpine
ENV OFFICE_API_UPSTREAM=office-server:8080
ENV NGINX_ENVSUBST_FILTER=OFFICE_API_UPSTREAM
COPY deploy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /build/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/login || exit 1
