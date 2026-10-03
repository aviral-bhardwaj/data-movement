FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm install --workspace=backend --include-workspace-root=false
COPY backend backend
COPY .env.example .env
EXPOSE 8080
CMD ["npm", "-w", "backend", "run", "api"]
