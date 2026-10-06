# Two-stage: node builds the Vite bundle, nginx serves it and proxies API/WS
# to the backend container (mirrors the Vite dev-server proxy, /api stripped).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build


FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
