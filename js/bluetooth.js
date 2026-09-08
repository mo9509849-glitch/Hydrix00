/* ============================================================
   Hydrix — وحدة الاتصال بالبلوتوث (BLE)
   تتصل بجهاز ESP32 الذي يعمل كـ BLE UART:
     Service : 0000ffe0-…
     RX      : 0000ffe1-…  (التطبيق → ESP32) كتابة الأوامر
     TX      : 0000ffe2-…  (ESP32 → التطبيق) قراءات JSON
   ملاحظة: Web Bluetooth يعمل على Chrome/Edge (أندرويد وسطح المكتب)
   ويتطلب سياقاً آمناً (HTTPS أو localhost).

   ✅ نسخة مُصلحة: تضيف تشخيصاً واضحاً في الـ Console لكل خطوة،
   وتدعم تلقائياً الوحدات اللي بتستخدم خاصية واحدة (0xFFE1) للكتابة
   والإشعارات معاً (زي بعض وحدات HM-10 الشائعة) بدل الخاصيتين
   المنفصلتين، عشان الاتصال ينجح حتى لو الفريموير مختلف شوية.
   ============================================================ */

const HydrixBLE = (() => {
  const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
  const RX_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"; // write
  const TX_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"; // notify

  let device = null;
  let rxChar = null;
  let writeQueue = Promise.resolve(); // طابور تسلسلي لأوامر الكتابة
  let onMessage = null;
  let onStateChange = null; // (connected:boolean) => void
  let onLog = null;         // (level, message) => void  — تشخيص اختياري للواجهة

  function log(level, msg) {
    const tag = "[Hydrix BLE]";
    if (level === "error") console.error(tag, msg);
    else if (level === "warn") console.warn(tag, msg);
    else console.log(tag, msg);
    if (onLog) onLog(level, msg);
  }

  function supported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  // فحص إضافي: هل يوجد أي محول بلوتوث متاح على الجهاز أصلاً؟
  async function checkAvailability() {
    if (!supported()) return false;
    if (!navigator.bluetooth.getAvailability) return true; // متصفح قديم لا يدعم الفحص، افترض التوفر
    try {
      return await navigator.bluetooth.getAvailability();
    } catch {
      return true;
    }
  }

  async function connect() {
    if (!supported()) {
      throw new Error(
        "البلوتوث غير مدعوم في هذا المتصفح — لازم Chrome على أندرويد أو Chrome/Edge على كمبيوتر، وعلى HTTPS (مش ملف محلي)."
      );
    }
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      throw new Error("لازم تفتح التطبيق عبر HTTPS أو من localhost عشان البلوتوث يشتغل.");
    }
    if (device && device.gatt && device.gatt.connected) {
      log("info", "الجهاز متصل بالفعل");
      return device;
    }

    const available = await checkAvailability();
    if (!available) {
      throw new Error("مفيش بلوتوث متاح على الجهاز ده — تأكد إن البلوتوث شغال في إعدادات الموبايل/الكمبيوتر.");
    }

    log("info", "فتح نافذة اختيار الأجهزة القريبة… (لو النافذة مافتحتش، افحص Location/GPS شغال ولا لأ)");
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Hydrix" }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (err) {
      // NotFoundError = المستخدم قفل النافذة أو مفيش جهاز اسمه يبدأ بـ Hydrix ظاهر
      log("error", `requestDevice فشل: ${err.name} — ${err.message}`);
      throw err;
    }

    log("info", `تم اختيار الجهاز: ${device.name || "(بدون اسم)"}`);

    device.addEventListener("gattserverdisconnected", () => {
      log("warn", "انقطع اتصال GATT");
      rxChar = null;
      if (onStateChange) onStateChange(false);
    });

    log("info", "جارٍ الاتصال بخادم GATT…");
    const server = await device.gatt.connect();

    log("info", "جارٍ البحث عن الخدمة (Service)…");
    const service = await server.getPrimaryService(SERVICE_UUID);

    log("info", "جارٍ البحث عن خاصية الكتابة (RX)…");
    rxChar = await service.getCharacteristic(RX_UUID);

    // نحاول نلاقي خاصية إشعارات منفصلة (TX)، ولو مش موجودة نستخدم نفس RX
    // (بعض وحدات UART زي HM-10 بتستخدم خاصية واحدة بس للكتابة والإشعار معاً)
    let txChar;
    try {
      log("info", "جارٍ البحث عن خاصية الإشعارات (TX)…");
      txChar = await service.getCharacteristic(TX_UUID);
    } catch (err) {
      log("warn", `مفيش خاصية TX منفصلة (${TX_UUID})، هنستخدم خاصية RX نفسها للإشعارات كحل احتياطي.`);
      txChar = rxChar;
    }

    if (!txChar.properties.notify && !txChar.properties.indicate) {
      log("warn", "الخاصية دي مش بتدعم notify/indicate — ممكن ماتوصلش قراءات حية من الجهاز.");
    }

    await txChar.startNotifications();
    txChar.addEventListener("characteristicvaluechanged", (e) => {
      const text = new TextDecoder().decode(e.target.value);
      if (!onMessage) return;
      try {
        onMessage(JSON.parse(text));
      } catch {
        onMessage(text.trim());
      }
    });

    log("info", "تم الاتصال بنجاح ✅");
    if (onStateChange) onStateChange(true);
    return device;
  }

  function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    rxChar = null;
    writeQueue = Promise.resolve();
  }

  function send(cmd) {
  if (!rxChar) return false;
     const bytes = new TextEncoder().encode(cmd + "\n");
  // البلوتوث مايقبلش عمليتين كتابة في نفس اللحظة — لو بعتنا
  // أمرين ورا بعض من غير استنى، التاني بيفشل بخطأ
  // "GATT operation already in progress". الطابور ده بيخلي
  // كل أمر يستنى اللي قبله يخلص فعليًا قبل ما يتبعت.
     writeQueue = writeQueue
        .then(() => rxChar.writeValue(bytes))
        .catch((err) => console.warn("BLE write failed:", err));
     return true;
}
  function isConnected() {
    return !!(device && device.gatt && device.gatt.connected && rxChar);
  }

  return {
    supported,
    checkAvailability,
    connect,
    disconnect,
    send,
    isConnected,
    set onMessage(fn) { onMessage = fn; },
    set onStateChange(fn) { onStateChange = fn; },
    set onLog(fn) { onLog = fn; },
  };
})();
