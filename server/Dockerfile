FROM golang:1.26-alpine AS build
WORKDIR /build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/office-api ./cmd/office

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && addgroup -g 10001 office && adduser -D -u 10001 -G office office && mkdir -p /var/lib/office && chown office:office /var/lib/office
WORKDIR /app
COPY --from=build /out/office-api /app/office-api
COPY data /app/data
COPY config /app/config
USER office:office
ENV HOST=0.0.0.0 PORT=8080 OFFICE_DATA_DIR=/var/lib/office
EXPOSE 8080
VOLUME ["/var/lib/office"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD health_host="${OFFICE_PUBLIC_ORIGIN#*://}"; health_host="${health_host%%/*}"; wget -q --header="Host: ${health_host:-127.0.0.1:8080}" -O /dev/null http://127.0.0.1:8080/api/livez || exit 1
ENTRYPOINT ["/app/office-api"]
