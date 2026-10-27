FROM nginx:latest

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY njs/ /etc/nginx/njs/
COPY sites.json /etc/nginx/sites.json
COPY --chmod=0755 docker-entrypoint.d/05-setup.sh /docker-entrypoint.d/05-setup.sh
RUN mkdir -p /srv/sites/.tmp && chown -R nginx:nginx /srv/sites

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1
