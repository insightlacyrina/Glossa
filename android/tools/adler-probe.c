/* Diagnostic only. No application or WebView library patching.
 * Exact target ELF SHA256 (must also be checked by the Java caller):
 * e154b524119b6670b824d3e11a1794bf32e4a497aef18ed5d76fbe6e01d4eded
 * GNU Build ID: 68dabd72c6088238cbfc9a5fbfe211f916771df5
 * Address 0x3f8f260 is valid ONLY for that exact ELF.
 */
#include <jni.h>

typedef unsigned char u8;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned long (*adler_fn)(unsigned long, const u8 *, unsigned int);

static u32 read32(const u8 *p) {
  return (u32)p[0] | ((u32)p[1] << 8) | ((u32)p[2] << 16) | ((u32)p[3] << 24);
}
static u64 read64(const u8 *p) {
  return (u64)read32(p) | ((u64)read32(p + 4) << 32);
}

static jint fail(JNIEnv *env, const char *reason) {
  jclass type = (*env)->FindClass(env, "java/lang/IllegalArgumentException");
  if (type) (*env)->ThrowNew(env, type, reason);
  return 0;
}

/* Restrict parsing to the known target's first mapped ELF page. */
static int matches_build_id(const u8 *base) {
  static const u8 expected[20] = {
    0x68,0xda,0xbd,0x72,0xc6,0x08,0x82,0x38,0xcb,0xfc,
    0x9a,0x5f,0xbf,0xe2,0x11,0xf9,0x16,0x77,0x1d,0xf5
  };
  if (base[0] != 0x7f || base[1] != 'E' || base[2] != 'L' || base[3] != 'F' ||
      base[4] != 2 || base[5] != 1 || base[6] != 1 ||
      base[18] != 62 || base[19] != 0) return 0;
  const u64 phoff = read64(base + 32);
  const u32 phsize = (u32)base[54] | ((u32)base[55] << 8);
  const u32 phcount = (u32)base[56] | ((u32)base[57] << 8);
  if (phsize != 56 || phcount == 0 || phcount > 32 ||
      phoff > 4096 || phoff + (u64)phsize * phcount > 4096) return 0;
  for (u32 i = 0; i < phcount; ++i) {
    const u8 *ph = base + phoff + (u64)i * phsize;
    if (read32(ph) != 4) continue;  /* PT_NOTE */
    const u64 va = read64(ph + 16), size = read64(ph + 40);
    if (va > 4096 || size > 4096 || va + size > 4096) continue;
    u64 pos = va, end = va + size;
    while (pos + 12 <= end) {
      const u32 namesz = read32(base + pos);
      const u32 descsz = read32(base + pos + 4);
      const u32 type = read32(base + pos + 8);
      const u64 name = pos + 12;
      const u64 desc = name + (((u64)namesz + 3) & ~(u64)3);
      const u64 next = desc + (((u64)descsz + 3) & ~(u64)3);
      if (next > end || next <= pos) return 0;
      if (namesz == 4 && descsz == 20 && type == 3 &&
          base[name] == 'G' && base[name + 1] == 'N' &&
          base[name + 2] == 'U' && base[name + 3] == 0) {
        for (u32 j = 0; j < 20; ++j)
          if (base[desc + j] != expected[j]) return 0;
        return 1;
      }
      pos = next;
    }
  }
  return 0;
}

/* Every JNI entry reuses the same address, buffer and exact mapped-identity guards. */
static adler_fn guarded_target(JNIEnv *env, jlong libBase, jobject buffer,
                               jint length, const u8 **payload) {
  if (libBase <= 0 || ((u64)libBase & 4095) != 0) {
    fail(env, "Expected the readable, mapped ELF load bias, page aligned");
    return (adler_fn)0;
  }
  if (!buffer || length < 0 || length > 16 * 1024 * 1024) {
    fail(env, "Expected a direct buffer and length in 0..16MiB");
    return (adler_fn)0;
  }
  const jlong capacity = (*env)->GetDirectBufferCapacity(env, buffer);
  *payload = (const u8 *)(*env)->GetDirectBufferAddress(env, buffer);
  if (capacity < 0 || (jlong)length > capacity || (!*payload && length != 0)) {
    fail(env, "Buffer is not direct or length exceeds capacity");
    return (adler_fn)0;
  }
  const u8 *base = (const u8 *)(u64)libBase;
  if (!matches_build_id(base)) {
    fail(env, "Refused: mapped ELF Build ID/ABI differs from exact diagnostic target");
    return (adler_fn)0;
  }
  return (adler_fn)((u64)libBase + 0x3f8f260ULL);
}

JNIEXPORT jint JNICALL Java_local_quietpaper_NativeAdlerProbe_checksum(
    JNIEnv *env, jclass ignored, jlong libBase, jobject buffer, jint length) {
  (void)ignored;
  const u8 *payload;
  adler_fn fn = guarded_target(env, libBase, buffer, length, &payload);
  if (!fn) return 0;  /* guarded_target has raised a Java exception. */
  (void)fn(0, (const u8 *)0, 0);
  return (jint)fn(0, payload, (unsigned int)length);
}

JNIEXPORT jint JNICALL Java_local_quietpaper_NativeAdlerProbe_checksumChunked(
    JNIEnv *env, jclass ignored, jlong libBase, jobject buffer, jint length) {
  (void)ignored;
  const u8 *payload;
  adler_fn fn = guarded_target(env, libBase, buffer, length, &payload);
  if (!fn) return 0;
  (void)fn(0, (const u8 *)0, 0);
  unsigned long value = 0;
  unsigned int remaining = (unsigned int)length;
  while (remaining) {
    /* Keep each call below this exact library's >=64-byte SIMD dispatch branch.
     * No library patch or explicit CPU/dispatcher flag write occurs.
     */
    const unsigned int count = remaining > 32 ? 32 : remaining;
    value = fn(value, payload, count);
    payload += count;
    remaining -= count;
  }
  return (jint)value;
}
