# Stage 1: Build binary
FROM golang:1.23-alpine AS builder

WORKDIR /src

# Download dependencies first for better layer caching
COPY go.mod ./
RUN go mod tidy && go mod download

COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /vaulty .

# Stage 2: Minimal runtime image
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /vaulty /app/vaulty

# Create non-root user for volume safety (adjust UID/GID to match your host user if needed)
RUN addgroup -g 1000 syncuser && \
    adduser -D -u 1000 -G syncuser syncuser && \
    mkdir -p /data/vault && \
    chown -R syncuser:syncuser /data/vault

USER syncuser

EXPOSE 8080
ENV PORT=8080
ENV VAULT_DIR=/data/vault
ENV GIN_MODE=release

ENTRYPOINT ["/app/vaulty"]