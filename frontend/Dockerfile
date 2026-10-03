FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY frontend/package.json frontend/
RUN npm install --workspace=frontend --include-workspace-root=false
COPY frontend frontend
RUN npm -w frontend run build

FROM nginx:alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
