# Reuse the project's pinned Python image for the CA bundle needed by HTTPS APT sources.
FROM python:3.13-slim@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1 AS certificates
FROM debian:trixie-slim AS apt-sources
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ARG DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
# Keep the base image's suites, components and Debian archive signing keys.
RUN printf '%s\n' 'Acquire::https::CAInfo "/etc/ssl/certs/ca-certificates.crt";' > /etc/apt/apt.conf.d/80mirror-ca && \
    sources=/etc/apt/sources.list.d/debian.sources && \
    awk -v main="$DEBIAN_MIRROR" -v security="$DEBIAN_SECURITY_MIRROR" ' \
        /^URIs: .*\/debian$/          { print "URIs: " main; found_main = 1; next } \
        /^URIs: .*\/debian-security$/ { print "URIs: " security; found_security = 1; next } \
        { print } END { if (!found_main || !found_security) exit 1 } \
    ' "$sources" > "$sources.new" && mv "$sources.new" "$sources"

FROM apt-sources
# Debian-signed security updates supply LibreOffice. Rebuild on security updates;
# record the resulting image digest for a production deployment.
RUN apt-get -o APT::Update::Error-Mode=any update && apt-get install -y --no-install-recommends libreoffice-impress python3 fonts-dejavu-core fonts-noto-cjk \
    && dpkg-query -W libreoffice-core > /opt/converter-package-version \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /work && chown 10001:10001 /app /work
COPY server.py /app/server.py
USER 10001:10001
ENV HOME=/work TMPDIR=/work PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
EXPOSE 8090
CMD ["python3", "server.py"]
