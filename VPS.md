# Запуск на VPS

Нужен Linux VPS с Docker Engine и Compose plugin. Проверка: `docker --version`, `docker compose version`. Если Docker отсутствует: официальные инструкции [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) / [Debian](https://docs.docker.com/engine/install/debian/). При необходимости используйте `sudo` для Docker-команд.

## Первый запуск

1. Подключитесь к VPS:

   ```sh
   ssh USER@VPS_IP
   ```

2. Скачайте репозиторий:

   ```sh
   git clone https://github.com/Kerber0ss/sumy-alarm-map.git
   cd sumy-alarm-map
   ```

3. Загрузите готовый образ и запустите сервис:

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

   Сборка на VPS не нужна. Образ находится в GHCR: `ghcr.io/kerber0ss/sumy-alarm-map:latest`. Поддерживаются amd64 и arm64. API-ключи и volumes не требуются.

4. Проверьте HTTP и источники:

   ```sh
   curl --fail --silent --output /dev/null --write-out 'HTTP %{http_code}\n' http://127.0.0.1:8765/
   curl --fail http://127.0.0.1:8765/api/state
   docker compose logs --tail=50 airalarm
   ```

   Ожидается HTTP 200. В JSON `sources.alerts.fresh` и `sources.targets.fresh` отражают свежесть внешних данных. Healthcheck контейнера проверяет доступность HTML, но не upstream-источники. Статус `healthy` появляется после очередной проверки.

5. Откройте **http://VPS_IP:8765**. Разрешите входящий TCP 8765 в панели провайдера/правилах VPS, если доступ блокируется. По умолчанию видны карта и кнопка панелей.

## Порт, сеть и HTTPS

По умолчанию порт опубликован на всех интерфейсах VPS, авторизации в приложении нет. Нужен исходящий HTTPS к map.ukrainealarm.com; браузер также загружает тайлы OpenStreetMap.

Для другого порта создайте `.env` рядом с compose.yaml:

```dotenv
AIRALARM_PORT=8080
```

Затем `docker compose up -d`; адрес станет http://VPS_IP:8080. Внутренний порт контейнера остаётся 8765.

Для reverse proxy **на хосте** ограничьте публикацию loopback:

```dotenv
AIRALARM_BIND_ADDRESS=127.0.0.1
AIRALARM_PORT=8765
```

После `docker compose up -d` направьте host reverse proxy на http://127.0.0.1:8765. Прямой доступ по VPS_IP к этому порту тогда недоступен. Если proxy сам в Docker, его 127.0.0.1 относится к нему самому: используйте общую Docker-сеть и upstream `airalarm:8765` либо адрес Docker-хоста.

Для HTTPS настройте свой домен и действительный сертификат на reverse proxy. Это не требует изменений в приложении.

## Встраивание в Home Assistant

Используйте URL, доступный из браузера/телефона, где открыт HA, например **https://alarm.example.com**. Адрес 127.0.0.1 на телефоне относится к телефону.

При HTTPS у HA используйте HTTPS и для карты: HTTP iframe может блокироваться как mixed content. Не добавляйте в proxy заголовки X-Frame-Options или CSP frame-ancestors, запрещающие origin вашего HA. Карта по умолчанию уже занимает всю площадь iframe, панели доступны по кнопке. Реальная настройка вашего HA/proxy в этот репозиторий не входит.

## Обновление

В каталоге приложения на VPS:

```sh
git pull --ff-only
docker compose pull
docker compose up -d
docker compose ps
```

`latest` — последняя успешная сборка main. Для фиксации/отката используйте доступный тег `sha-<полный commit SHA>` из раздела Packages репозитория вместо `latest` в поле image. Не удаляйте предыдущий образ до проверки новой версии.

## Остановка

```sh
docker compose down
```

Файлы репозитория и `.env` сохранятся. Данные карты только в памяти, после следующего старта будут получены заново. `restart: unless-stopped` обеспечивает повторный запуск контейнера после перезапуска Docker, если вы не остановили его вручную.

Для самостоятельной сборки на VPS: `docker compose -f compose.yaml -f compose.build.yaml up -d --build`.

На конкретном VPS автора развёртывание автоматически не выполняется. Подробности тестов контейнера: [GitHub Actions](https://github.com/Kerber0ss/sumy-alarm-map/actions). Формат переменных: [Docker Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
