# Запуск через Portainer

Инструкция для **Docker Standalone** environment в Portainer. Используется готовый образ GHCR, сборка на сервере не нужна. У сервера должен быть доступ к ghcr.io и neptun.in.ua, а у браузера — к тайлам OpenStreetMap.

## Через Web editor

1. В Portainer откройте нужный Docker environment → **Stacks → Add stack**. Имя: `sumy-alarm-map`.
2. Выберите **Web editor** и вставьте:

```yaml
services:
  airalarm:
    image: ghcr.io/kerber0ss/sumy-alarm-map:all-ukraine-neptun
    ports:
      - "${AIRALARM_BIND_ADDRESS:-0.0.0.0}:${AIRALARM_PORT:-8765}:8765"
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=3).close()"]
      interval: 30s
      timeout: 5s
      start_period: 5s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

3. При необходимости в **Environment variables** добавьте `AIRALARM_PORT=8080` для другого порта. По умолчанию доступен 8765. Для loopback-публикации за reverse proxy на хосте: `AIRALARM_BIND_ADDRESS=127.0.0.1`.
4. Нажмите **Deploy the stack**. Дождитесь запуска контейнера; затем в Containers появится статус healthy. Отдельная регистрация в Docker Hub не нужна.
5. Откройте **http://SERVER_IP:8765** (либо выбранный порт). Если не открывается — проверьте опубликованный порт, сетевые правила VPS и логи airalarm в Portainer.

## Через Git repository

Вместо Web editor при создании Stack выберите **Repository**:

```text
Repository URL: https://github.com/Kerber0ss/sumy-alarm-map
Repository reference: refs/heads/all-ukraine
Compose path: compose.yaml
```

Авторизация для публичного репозитория не требуется. Оставьте остальные настройки обычного Stack и нажмите Deploy. Используется image из compose.yaml, а не сборка Dockerfile. `compose.build.yaml` для этого сценария не нужен.

## Обновление и откат

Для новой версии в Stack используйте действие обновления/повторного развёртывания с включённой загрузкой свежего образа (**Re-pull image / Pull latest image**, название зависит от версии Portainer). Одного restart контейнера недостаточно для загрузки нового образа.

Для фиксации версии замените image на опубликованный `ghcr.io/kerber0ss/sumy-alarm-map:sha-<полный commit SHA>`, затем обновите Stack. Теги доступны в [Packages репозитория](https://github.com/Kerber0ss/sumy-alarm-map/pkgs/container/sumy-alarm-map).

Удаление Stack останавливает приложение; сохранять данные/volumes не требуется.

## Для Home Assistant

По умолчанию карта открывается без панелей. Вставляйте доступный браузеру URL. При HTTPS у HA используйте HTTPS-домен карты через reverse proxy. Конфигурация сети/proxy и особенности loopback для proxy в контейнере разобраны в **[VPS.md](VPS.md)**.

Приложение публикует общедоступные данные, собственной авторизации у него нет. Порт 8765 по умолчанию доступен на всех интерфейсах сервера; для внешнего доступа должны быть разрешены соответствующие сетевые правила.

Официальная справка Portainer: [Add a new stack](https://docs.portainer.io/user/docker/stacks/add). Реальное развёртывание в вашем Portainer автоматически не выполняется.
