#include "qdiscord.h"

#include <QJsonDocument>
#include <QRandomGenerator64>
#include <QFile>
#include <QHttpMultiPart>
#include <QEventLoop>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QDesktopServices>
#include <QHostAddress>
#include <QUrlQuery>
#include <QMetaEnum>
#include <QRegularExpression>

struct MessageHeader {
    uint32_t opcode;
    uint32_t length;
};
static_assert(sizeof(MessageHeader) == 8);

// Per-message IPC tracing serializes the full JSON on every send/recv, so it is gated behind an
// environment variable and off by default. Set DVM_VERBOSE_IPC=1 to enable.
static bool ipcVerboseLogging() {
    static const bool enabled = qEnvironmentVariableIsSet("DVM_VERBOSE_IPC");
    return enabled;
}

double QDiscord::ipcToUIVolume(double v) {
    if(v <= 0)
        return 0;
    else if(v <= 100)
        return 17.362 * log(v) + 20.054;
    else
        return 144.86 * log(v) - 567.21;
}

double QDiscord::uiToIPCVolume(double v) {
    if(v <= 0)
        return 0;
    else if(v <= 100)
        return exp((v - 20.054) / 17.362);
    else
        return exp((v + 567.21) / 144.86);
}

QDiscord::QDiscord()
    : legcordSocketServer_(QStringLiteral("Stream Deck Discord Volume Mixer Legcord Bridge"), QWebSocketServer::NonSecureMode, this) {
    QObject::connect(&socket_, &QLocalSocket::errorOccurred, this, [this](const QLocalSocket::LocalSocketError &err) {
        qWarning() << "QDiscord socket error: " << static_cast<int>(err);
    });
    QObject::connect(&socket_, &QLocalSocket::disconnected, this, [this] {
        qDebug() << "Disconnected";
        if(connectionError_.isEmpty())
            connectionError_ = "DISCONNECTED";
        disconnect();
    });
    QObject::connect(&socket_, &QLocalSocket::readyRead, this, [this] {
        if(blockingRead_)
            return;

        readAndProcessMessages();
        if(socket_.bytesAvailable())
            qDebug() << "ASSERTION FAILED: bytes still available after read and process messages";
    });

    legcordPollTimer_.setInterval(750);
    QObject::connect(&legcordPollTimer_, &QTimer::timeout, this, &QDiscord::pollLegcordBridgeEvents);

    QObject::connect(&legcordSocketServer_, &QWebSocketServer::newConnection, this, [this] {
        QWebSocket *socket = legcordSocketServer_.nextPendingConnection();
        if(!socket)
            return;

        if(legcordSocket_) {
            if(legcordSocketUserID_.isEmpty()) {
                legcordSocket_->close(QWebSocketProtocol::CloseCodeNormal, QStringLiteral("Replaced by authenticated Legcord bridge"));
                legcordSocket_->deleteLater();
                legcordSocket_ = nullptr;
            } else {
                socket->close(QWebSocketProtocol::CloseCodePolicyViolated, QStringLiteral("Only one Legcord bridge client is supported"));
                socket->deleteLater();
                return;
            }
        }

        legcordSocket_ = socket;
        legcordSocketUserID_.clear();

        QObject::connect(socket, &QWebSocket::textMessageReceived, this, &QDiscord::processLegcordSocketMessage);
        QObject::connect(socket, &QWebSocket::disconnected, this, [this, socket] {
            if(legcordSocket_ == socket)
                legcordSocket_ = nullptr;

            socket->deleteLater();
            if(backend_ == Backend::LegcordBridge)
                disconnect();
        });
    });
}

QDiscord::~QDiscord() {
    for(const auto r: pendingReplies_)
        delete r;
}

bool QDiscord::connect(const QString &clientID, const QString &clientSecret) {
    connectionError_.clear();
    processing_++;
    const bool r = [&]() {
        if(!clientID.isEmpty() && !clientSecret.isEmpty()) {
            if(connectDiscordIpc(clientID, clientSecret)) {
                backend_ = Backend::DiscordIpc;
                return true;
            }

            const QString ipcConnectionError = connectionError_;
            socket_.disconnectFromServer();

            if(connectLegcordBridge())
                return true;

            connectionError_ = ipcConnectionError.isEmpty() ? QStringLiteral("ERR 1") : ipcConnectionError;
            return false;
        }

        if(connectLegcordBridge() || connectLegcordSocketBridge())
            return true;

        qDebug() << "Missing client ID or secret and Legcord bridge is unavailable";
        connectionError_ = "ERR 0";
        return false;
    }();

    if(!r)
        disconnect();

    else {
        isConnected_ = true;
        connectionError_.clear();
        emit connected();
    }

    processing_--;
    return r;
}

bool QDiscord::connectDiscordIpc(const QString &clientID, const QString &clientSecret) {
    if(clientID.isEmpty() || clientSecret.isEmpty()) {
        qDebug() << "Missing client ID or secret";
        connectionError_ = "ERR 0";
        return false;
    }

        // start connecting
        for(int i = 0; i < 10; i++) {
            socket_.disconnectFromServer();
            socket_.connectToServer("discord-ipc-" + QString::number(i));
            qDebug() << "Trying to connect to Discord (" << i << ")";

            // A local named pipe connects within milliseconds or not at all; a short timeout keeps
            // a missing/stuck Discord from freezing the event loop for up to 30s (10 x 3s).
            if(socket_.waitForConnected(300))
                break;
        }
        if(socket_.state() != QLocalSocket::ConnectedState) {
            qDebug() << "Connection failed";
            connectionError_ = "ERR 1";
            return false;
        }

        qDebug() << "Connected";
        static const QStringList scopes{"rpc", "identify"};

        // Handshake and dispatch Receive DISPATCH
        {
            sendMessage(QJsonObject{
                                    {"v",         1},
                                    {"client_id", clientID},
                                    }, 0);

            const QDiscordMessage msg = readMessage();

            if(msg.json.isEmpty()) {
                qWarning() << "QDiscord - empty response" << msg.json;
                connectionError_ = "ERR 8";
                return false;
            }


            if(msg.json["cmd"] != "DISPATCH") {
                qWarning() << "QDiscord - unexpected message (expected DISPATCH)" << msg.json["cmd"];
                connectionError_ = "ERR 2";
                return false;
            }

            cdn_ = msg.data["config"]["cdn_host"].toString();
        }

        QJsonObject oauthData;
        QFile oauthFile("discordOauth.json");
        if(oauthFile.exists()) {
            oauthFile.open(QIODevice::ReadOnly);
            oauthData = QJsonDocument::fromJson(oauthFile.readAll()).object();
            oauthFile.close();
        }

        const auto saveOauthData = [&] {
            oauthFile.open(QIODevice::WriteOnly);
            oauthFile.write(QJsonDocument(oauthData).toJson(QJsonDocument::Compact));
            oauthFile.close();
        };

        const auto loadIdentityFromAuth = [&](const QJsonObject &msg) {
            userID_ = msg["data"]["user"]["id"].toString();
        };

        // Try refreshing token
        if(!oauthData["refresh_token"].isNull()) {
            QNetworkAccessManager nm;
            QNetworkRequest req;
            const QUrlQuery q{
                              {"client_id",     clientID},
                              {"client_secret", clientSecret},
                              {"refresh_token", oauthData["refresh_token"].toString()},
                              {"scope",         scopes.join(' ')},
                              {"grant_type",    "refresh_token"},
                              };
            QUrl url("https://discord.com/api/oauth2/token");
            req.setUrl(url);
            req.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
            auto r = nm.post(req, q.toString(QUrl::FullyEncoded).toUtf8());

            QEventLoop l;
            QObject::connect(r, &QNetworkReply::finished, &l, &QEventLoop::quit);

            qDebug() << "REFRESH REQ" << req.url() << q.toString();

            l.exec();
            r->deleteLater();

            if(r->error() == QNetworkReply::NoError) {
                qDebug() << "Successfully refreshed token";
                oauthData = QJsonDocument::fromJson(r->readAll()).object();
                saveOauthData();
            }
            else {
                connectionError_ = "ERR 3";
                qWarning() << "QDiscord Network error (refresh)" << r->errorString();
            }
        }

        // Authenticate from stored token
        if(!oauthData["access_token"].isNull()) {
            sendMessage(QJsonObject{
                                    {"cmd",   +CommandType::authenticate},
                                    {"nonce", "auth_0"},
                                    {"args",  QJsonObject{
                                                 {"access_token", oauthData["access_token"].toString()}
                                             }},
                                    });

            const QDiscordMessage msg = readMessage();
            if(msg.json["cmd"] == "AUTHENTICATE" && msg.json["evt"] != "ERROR") {
                qDebug() << "Connected through pre-stored token";
                loadIdentityFromAuth(msg.json);
                return true;
            }
        }

        // When we got here, it mens that the automatic authentication on background failed -> start from scratch
        oauthData = {};

        // Send authorization request
        {
            // Authorize in Discord
            QString authCode;
            {
                sendMessage(QJsonObject{
                                        {"cmd",   +CommandType::authorize},
                                        {"nonce", "auth_1"},
                                        {"args",  QJsonObject{
                                                     {"client_id", clientID},
                                                     {"scopes",    QJsonArray::fromStringList(scopes)}
                                                 }},
                                        });

                const QDiscordMessage msg = readMessage();
                if(msg.json["cmd"] != "AUTHORIZE" || msg.json["evt"] == "ERROR") {
                    connectionError_ = "ERR 4";
                    qWarning() << "AUTHORIZE ERROR" << msg.json;
                    return false;
                }

                authCode = msg.data["code"].toString();
            }

            // Get access token
            {
                QNetworkAccessManager nm;
                QNetworkRequest req;
                const QUrlQuery q{
                                  {"client_id",     clientID},
                                  {"client_secret", clientSecret},
                                  {"code",          authCode},
                                  {"scope",         scopes.join(' ')},
                                  {"grant_type",    "authorization_code"},
                                  };
                QUrl url("https://discord.com/api/oauth2/token");
                req.setUrl(url);
                req.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
                auto r = nm.post(req, q.toString(QUrl::FullyEncoded).toUtf8());

                QEventLoop l;
                QObject::connect(r, &QNetworkReply::finished, &l, &QEventLoop::quit);

                qDebug() << "AUTH REQ" << req.url() << q.toString();

                l.exec();
                r->deleteLater();

                if(r->error() != QNetworkReply::NoError) {
                    connectionError_ = "ERR 5";
                    qWarning() << "QDiscord Network error" << r->errorString();
                    return false;
                }

                oauthData = QJsonDocument::fromJson(r->readAll()).object();
            }

            if(oauthData["access_token"].toString().isEmpty()) {
                connectionError_ = "ERR 6";
                qWarning() << "QDiscord failed to obtain access token";
                return false;
            }

            saveOauthData();
        }

        // Authenticate
        {
            sendMessage(QJsonObject{
                                    {"cmd",   "AUTHENTICATE"},
                                    {"nonce", "auth_2"},
                                    {"args",  QJsonObject{
                                                 {"access_token", oauthData["access_token"].toString()}
                                             }},
                                    });

            const QDiscordMessage msg = readMessage();
            if(msg.json["cmd"] != "AUTHENTICATE" || msg.json["evt"] == "ERROR") {
                connectionError_ = "ERR 7";
                qWarning() << "AUTHENTICATE ERROR" << msg.json;
                return false;
            }

            loadIdentityFromAuth(msg.json);
        }

        qDebug() << "Connection successful";
        return true;
}

bool QDiscord::connectLegcordBridge() {
    socket_.disconnectFromServer();

    const QJsonObject health = requestLegcordBridge(QStringLiteral("GET"), QStringLiteral("/health"), {}, 1000);
    if(!health["ok"].toBool()) {
        connectionError_ = "ERR L";
        return false;
    }

    const QJsonObject auth = requestLegcordBridge(QStringLiteral("POST"), QStringLiteral("/rpc"), QJsonObject{
        {"cmd",   "AUTHENTICATE"},
        {"nonce", "legcord_auth"},
        {"args",  QJsonObject{}},
    }, 1500);

    if(auth["cmd"].toString() != "AUTHENTICATE" || auth["evt"].toString() == "ERROR") {
        connectionError_ = "ERR L";
        qWarning() << "Legcord bridge authentication failed" << auth;
        return false;
    }

    userID_ = auth["data"].toObject()["user"].toObject()["id"].toString();
    cdn_ = QStringLiteral("cdn.discordapp.com");
    backend_ = Backend::LegcordBridge;
    legcordLastEventId_ = health["last_event_id"].toInt();
    legcordPollTimer_.start();
    qDebug() << "Connected through Legcord bridge";
    return true;
}

bool QDiscord::connectLegcordSocketBridge() {
    if(!startLegcordSocketBridge()) {
        connectionError_ = "ERR L";
        return false;
    }

    if(legcordSocket_ && !legcordSocketUserID_.isEmpty()) {
        userID_ = legcordSocketUserID_;
        cdn_ = QStringLiteral("cdn.discordapp.com");
        backend_ = Backend::LegcordBridge;
        qDebug() << "Connected through Legcord extension bridge";
        return true;
    }

    QEventLoop loop;
    QTimer timeout;
    QTimer poll;
    timeout.setSingleShot(true);
    poll.setInterval(50);

    QObject::connect(&timeout, &QTimer::timeout, &loop, &QEventLoop::quit);
    QObject::connect(&poll, &QTimer::timeout, &loop, [&] {
        if(legcordSocket_ && !legcordSocketUserID_.isEmpty())
            loop.quit();
    });

    timeout.start(4000);
    poll.start();
    processing_++;
    loop.exec();
    processing_--;

    if(!(legcordSocket_ && !legcordSocketUserID_.isEmpty())) {
        connectionError_ = "ERR L";
        return false;
    }

    userID_ = legcordSocketUserID_;
    cdn_ = QStringLiteral("cdn.discordapp.com");
    backend_ = Backend::LegcordBridge;
    qDebug() << "Connected through Legcord extension bridge";
    return true;
}

bool QDiscord::startLegcordSocketBridge() {
    if(legcordSocketServer_.isListening())
        return true;

    const bool listening = legcordSocketServer_.listen(QHostAddress::LocalHost, static_cast<quint16>(legcordBridgeUrl_.port(6888)));
    if(!listening)
        qWarning() << "Could not start Legcord extension bridge server" << legcordSocketServer_.errorString();

    return listening;
}

void QDiscord::stopLegcordSocketBridge() {
    if(legcordSocket_) {
        legcordSocket_->close();
        legcordSocket_->deleteLater();
        legcordSocket_ = nullptr;
    }

    legcordSocketServer_.close();
    legcordSocketUserID_.clear();
}

QJsonObject QDiscord::requestLegcordBridge(const QString &method, const QString &path, const QJsonObject &payload, int timeoutMs) {
    QNetworkRequest req(legcordBridgeUrl_.resolved(QUrl(path)));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");

    QNetworkReply *reply = nullptr;
    if(method == "GET")
        reply = netMgr_.get(req);

    else
        reply = netMgr_.post(req, QJsonDocument(payload).toJson(QJsonDocument::Compact));

    QEventLoop loop;
    QTimer timeout;
    timeout.setSingleShot(true);

    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timeout, &QTimer::timeout, &loop, &QEventLoop::quit);

    processing_++;
    timeout.start(timeoutMs);
    loop.exec();
    processing_--;

    if(!timeout.isActive()) {
        reply->abort();
        reply->deleteLater();
        qWarning() << "Legcord bridge request timed out" << method << path;
        return {};
    }

    timeout.stop();
    const QNetworkReply::NetworkError networkError = reply->error();
    const QByteArray body = reply->readAll();
    const QString errorString = reply->errorString();
    reply->deleteLater();

    if(networkError != QNetworkReply::NoError) {
        qWarning() << "Legcord bridge network error" << method << path << errorString;
        return {};
    }

    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(body, &parseError);
    if(parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        qWarning() << "Legcord bridge returned invalid JSON" << method << path << body;
        return {};
    }

    return doc.object();
}

void QDiscord::sendLegcordBridgeMessage(const QJsonObject &packet) {
    QNetworkRequest req(legcordBridgeUrl_.resolved(QUrl(QStringLiteral("/rpc"))));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");

    const QString nonce = packet["nonce"].toString();
    QNetworkReply *reply = netMgr_.post(req, QJsonDocument(packet).toJson(QJsonDocument::Compact));
    QObject::connect(reply, &QNetworkReply::finished, this, [this, reply, nonce, command = packet["cmd"].toString()] {
        QJsonObject response;

        if(reply->error() == QNetworkReply::NoError) {
            QJsonParseError parseError;
            response = QJsonDocument::fromJson(reply->readAll(), &parseError).object();
            if(parseError.error != QJsonParseError::NoError || response.isEmpty()) {
                response = QJsonObject{
                    {"cmd",   command},
                    {"evt",   "ERROR"},
                    {"nonce", nonce},
                    {"data",  QJsonObject{{"message", "Legcord bridge returned invalid JSON"}}},
                };
            }
        }
        else {
            response = QJsonObject{
                {"cmd",   command},
                {"evt",   "ERROR"},
                {"nonce", nonce},
                {"data",  QJsonObject{{"message", reply->errorString()}}},
            };
        }

        reply->deleteLater();

        if(pendingReplies_.contains(nonce))
            processMessage(QDiscordMessage::fromJson(response));
    });
}

void QDiscord::sendLegcordSocketMessage(const QJsonObject &packet) {
    const QString nonce = packet["nonce"].toString();
    if(!legcordSocket_) {
        processMessage(QDiscordMessage::fromJson(QJsonObject{
            {"cmd",   packet["cmd"]},
            {"evt",   "ERROR"},
            {"nonce", nonce},
            {"data",  QJsonObject{{"message", "Legcord extension bridge is not connected"}}},
        }));
        return;
    }

    legcordSocket_->sendTextMessage(QString::fromUtf8(QJsonDocument(packet).toJson(QJsonDocument::Compact)));
}

void QDiscord::processLegcordSocketMessage(const QString &message) {
    QJsonParseError parseError;
    const QJsonObject json = QJsonDocument::fromJson(message.toUtf8(), &parseError).object();
    if(parseError.error != QJsonParseError::NoError || json.isEmpty()) {
        qWarning() << "Legcord extension bridge returned invalid JSON" << message;
        return;
    }

    const QString reportedUserID = json["data"].toObject()["user"].toObject()["id"].toString();
    if(json["cmd"].toString() == "AUTHENTICATE" && !reportedUserID.isEmpty()) {
        legcordSocketUserID_ = reportedUserID;
        userID_ = reportedUserID;
    }

    processMessage(QDiscordMessage::fromJson(json));
}

void QDiscord::pollLegcordBridgeEvents() {
    if(!isConnected_ || backend_ != Backend::LegcordBridge || legcordPollInProgress_)
        return;

    legcordPollInProgress_ = true;
    const QJsonObject response = requestLegcordBridge(QStringLiteral("GET"), QStringLiteral("/events?after=%1").arg(legcordLastEventId_), {}, 750);
    legcordPollInProgress_ = false;

    const QJsonArray events = response["events"].toArray();
    for(const auto &eventValue: events) {
        const QJsonObject event = eventValue.toObject();
        const int id = event["id"].toInt();
        if(id > legcordLastEventId_)
            legcordLastEventId_ = id;

        const QJsonObject message = event["message"].toObject();
        if(!message.isEmpty())
            processMessage(QDiscordMessage::fromJson(message));
    }
}

void QDiscord::disconnect() {
    const bool wasConnected = isConnected_;

    legcordPollTimer_.stop();
    legcordPollInProgress_ = false;
    legcordLastEventId_ = 0;
    stopLegcordSocketBridge();
    socket_.disconnectFromServer();
    isConnected_ = false;
    backend_ = Backend::DiscordIpc;
    userID_.clear();

    if(wasConnected)
        emit disconnected();
}

QDiscordReply *QDiscord::sendCommand(const QString &command, const QJsonObject &args, const QJsonObject &msgOverrides) {
    const QString nonce = QStringLiteral("%1:%2").arg(QString::number(nonceCounter_++), QString::number(QRandomGenerator64::global()->generate()));
    QJsonObject message{
        {"cmd",   command},
        {"args",  args},
        {"nonce", nonce}
    };

    for(auto it = msgOverrides.begin(), end = msgOverrides.end(); it != end; it++)
        message[it.key()] = it.value();

    QDiscordReply *r = new QDiscordReply(nonce);
    pendingReplies_.insert(nonce, r);

    if(backend_ == Backend::LegcordBridge) {
        if(legcordSocket_)
            sendLegcordSocketMessage(message);

        else
            sendLegcordBridgeMessage(message);
    }

    else
        sendMessage(message);

    return r;
}

QImage QDiscord::getUserAvatar(const QString &userId, const QString &avatarId) {
    if(avatarId.isEmpty())
        return {};

    if(QImage * img = avatarsCache_.object(avatarId))
        return *img;

    // De-duplicate concurrent requests for the same avatar (update() can fire many times before it loads).
    if(avatarsRequested_.contains(avatarId))
        return {};
    avatarsRequested_.insert(avatarId);

    // Request a small CDN-sized image rather than the full-resolution original (keys render at <=72px).
    const QString url = QStringLiteral("https://%1/avatars/%2/%3.png?size=128").arg(cdn_, userId, avatarId);
    QNetworkReply *r = netMgr_.get(QNetworkRequest(QUrl(url)));
    QObject::connect(r, &QNetworkReply::finished, this, [this, r, avatarId] {
        const bool ok = (r->error() == QNetworkReply::NoError);
        const QImage img = ok ? QImage::fromData(r->readAll()) : QImage();
        r->deleteLater();
        avatarsRequested_.remove(avatarId);

        // Only cache valid avatars; let a failed fetch be retried on a later update instead of caching a null forever.
        if(!img.isNull()) {
            avatarsCache_.insert(avatarId, new QImage(img));
            emit avatarReady(avatarId, img);
        }
    });

    return {};
}

QDiscordMessage QDiscord::readMessage() {
    const QByteArray headerBA = blockingReadBytes(sizeof(MessageHeader));
    if(headerBA.isNull()) {
        qDebug() << "Empty json message";
        return {};
    }

    const MessageHeader &header = *reinterpret_cast<const MessageHeader *>(headerBA.data());

    const QByteArray data = blockingReadBytes(static_cast<int>(header.length));

    QJsonParseError err;
    QDiscordMessage result = QDiscordMessage::fromJson(QJsonDocument::fromJson(data, &err).object(), static_cast<int>(header.opcode));

    if(err.error != QJsonParseError::NoError)
        qWarning() << "QDiscord - failed to parse message\n\n" << data;

    if(ipcVerboseLogging())
        qDebug() << "<<<<< RECV\n" << header.opcode << header.length << result.json << "\n";

    return result;
}

void QDiscord::sendMessage(const QJsonObject &packet, int opCode) {
    const QByteArray payload = QJsonDocument(packet).toJson(QJsonDocument::Compact);

    if(ipcVerboseLogging())
        qDebug() << ">>>>> SEND\n" << opCode << payload.length() << packet << "\n";

    MessageHeader header;
    header.opcode = static_cast<uint32_t>(opCode);
    header.length = static_cast<uint32_t>(payload.length());

    socket_.write(QByteArray::fromRawData(reinterpret_cast<const char *>(&header), sizeof(MessageHeader)));
    socket_.write(payload);
}

void QDiscord::processMessage(const QDiscordMessage &msg) {
    if(QDiscordReply *r = pendingReplies_.take(msg.nonce)) {
        emit r->finished(msg);
        r->deleteLater();
        return;
    }

    emit messageReceived(msg);
}

QByteArray QDiscord::blockingReadBytes(int bytes) {
    blockingRead_++;
    processing_++;
    while(socket_.bytesAvailable() < bytes) {
        if(!socket_.waitForReadyRead(3000)) {
            qWarning() << "QDiscord - waitForReadyRead timeout" << socket_.bytesAvailable();
            processing_--;
            blockingRead_--;
            return {};
        }
    }
    processing_--;
    blockingRead_--;

    return socket_.read(bytes);
}

void QDiscord::readAndProcessMessages() {
    while(socket_.bytesAvailable())
        processMessage(readMessage());
}

QString operator +(QDiscord::CommandType ct) {
    static const QHash<int, QString> ht = [] {
        const auto me = QMetaEnum::fromType<QDiscord::CommandType>();
        const auto cnt = me.keyCount();

        QHash<int, QString> r;
        r.reserve(cnt);

        const QRegularExpression regex("([A-Z])");

        for(int i = 0; i < cnt; i++) {
            QString str = me.key(i);
            str.replace(regex, "_\\1"); // Add _ underscore before every capitalized letter (guildStatus -> guild_Status)
            str = str.toUpper(); // Convert all to uppercase (guild_Status -> GUILD_STATUS)

            r.insert(me.value(i), str);
        }

        return r;
    }();
    return ht.value(int(ct));
}
