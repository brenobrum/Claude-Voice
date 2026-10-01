// Voice-reactive orb: a shaded sphere of flowing warm color, ported from src/orb.js (WebGL) to a
// SwiftUI colorEffect shader.
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT).
static float3 mod289(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
static float4 mod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
static float4 permute(float4 x) { return mod289(((x * 34.0) + 1.0) * x); }
static float4 taylorInvSqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

static float snoise(float3 v) {
    const float2 C = float2(1.0 / 6.0, 1.0 / 3.0);
    const float4 D = float4(0.0, 0.5, 1.0, 2.0);
    float3 i = floor(v + dot(v, C.yyy));
    float3 x0 = v - i + dot(i, C.xxx);
    float3 g = step(x0.yzx, x0.xyz);
    float3 l = 1.0 - g;
    float3 i1 = min(g.xyz, l.zxy);
    float3 i2 = max(g.xyz, l.zxy);
    float3 x1 = x0 - i1 + C.xxx;
    float3 x2 = x0 - i2 + C.yyy;
    float3 x3 = x0 - D.yyy;
    i = mod289(i);
    float4 p = permute(permute(permute(
                i.z + float4(0.0, i1.z, i2.z, 1.0))
              + i.y + float4(0.0, i1.y, i2.y, 1.0))
              + i.x + float4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    float3 ns = n_ * D.wyz - D.xzx;
    float4 j = p - 49.0 * floor(p * ns.z * ns.z);
    float4 x_ = floor(j * ns.z);
    float4 y_ = floor(j - 7.0 * x_);
    float4 x = x_ * ns.x + ns.yyyy;
    float4 y = y_ * ns.x + ns.yyyy;
    float4 h = 1.0 - abs(x) - abs(y);
    float4 b0 = float4(x.xy, y.xy);
    float4 b1 = float4(x.zw, y.zw);
    float4 s0 = floor(b0) * 2.0 + 1.0;
    float4 s1 = floor(b1) * 2.0 + 1.0;
    float4 sh = -step(h, float4(0.0));
    float4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    float4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    float3 p0 = float3(a0.xy, h.x);
    float3 p1 = float3(a0.zw, h.y);
    float3 p2 = float3(a1.xy, h.z);
    float3 p3 = float3(a1.zw, h.w);
    float4 norm = taylorInvSqrt(float4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    float4 m = max(0.6 - float4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, float4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

static float fbm(float3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * snoise(p); p = p * 2.02 + float3(3.1, 1.7, 5.3); a *= 0.5; }
    return v;
}

// Ember -> orange -> amber -> white-hot ramp.
static float3 ramp(float x) {
    x = clamp(x, 0.0, 1.0);
    float3 c = mix(float3(0.42, 0.04, 0.06), float3(0.95, 0.24, 0.06), smoothstep(0.0, 0.35, x));
    c = mix(c, float3(1.0, 0.55, 0.12), smoothstep(0.3, 0.6, x));
    c = mix(c, float3(1.0, 0.8, 0.45), smoothstep(0.55, 0.8, x));
    return mix(c, float3(1.0, 0.97, 0.93), smoothstep(0.78, 1.0, x));
}

[[ stitchable ]] half4 orb(float2 pos, half4 color, float2 res, float t, float flow,
                           float level, float low, float high, float active, float speak) {
    float scale = min(res.x, res.y);
    float2 uv = (pos * 2.0 - res) / scale;
    uv.y = -uv.y; // GL's origin is bottom-left
    float energy = clamp(level * 1.2 + speak * 0.25, 0.0, 1.0);

    // Living silhouette: the edge breathes when idle and ripples with the voice.
    float ang = atan2(uv.y, uv.x);
    float2 ring = float2(cos(ang), sin(ang));
    float edgeN = snoise(float3(ring * 1.2, t * 0.35)) * 0.7 + snoise(float3(ring * 2.4, t * 0.5 + 4.0)) * 0.3 * energy;
    float R = 0.56 * mix(0.9, 1.0, active) * (1.0 + 0.015 * sin(t * 0.9) + level * 0.05);
    R *= 1.0 + edgeN * (0.012 + energy * 0.03);

    float2 p = uv / R;
    float r = length(p);
    float aa = 2.5 / (R * scale);

    float3 col = float3(0.0);
    float body = 1.0 - smoothstep(1.0 - aa, 1.0, r);

    if (r < 1.0) {
        float z = sqrt(1.0 - r * r);
        float3 nrm = float3(p, z);

        // Slow liquid flow on the sphere, domain-warped and stirred by the voice.
        float3 q = nrm * 0.95 + float3(0.0, flow * 0.6, flow);
        float3 warp = float3(snoise(q * 0.8 + float3(0.0, 0.0, t * 0.1)),
                             snoise(q * 0.8 + float3(5.2, 1.3, -t * 0.08)),
                             snoise(q * 0.8 + float3(9.1, 4.7, t * 0.12)));
        q += warp * (0.5 + low * 0.5);
        float f = fbm(q) * 0.5 + 0.5;
        float f2 = snoise(q * 1.7 + warp + t * 0.2) * 0.5 + 0.5;

        // Heat: brighter toward the core and with loudness.
        float heat = f * 0.85 + pow(z, 1.5) * 0.5 - 0.12 + energy * 0.1;
        col = ramp(heat);
        col = mix(col, float3(0.75, 0.12, 0.35), smoothstep(0.5, 0.05, heat) * 0.6);

        // Thin luminous veins that sharpen with high frequencies.
        float vein = pow(1.0 - abs(f2 * 2.0 - 1.0), 7.0);
        col += float3(1.0, 0.9, 0.8) * vein * (0.15 + high * 0.2) * z;

        // Glassy highlight + soft emissive core.
        float3 L = normalize(float3(-0.45, 0.55, 0.7));
        float spec = pow(max(dot(reflect(-L, nrm), float3(0.0, 0.0, 1.0)), 0.0), 40.0);
        col += float3(1.0) * spec * 0.35;
        col += float3(1.0, 0.9, 0.78) * pow(z, 6.0) * (0.08 + energy * 0.3);

        // Fresnel rim: hot orange melting into white at the edge.
        float fr = 1.0 - z;
        col = mix(col, float3(1.0, 0.45, 0.15), pow(fr, 2.2) * 0.55);
        col += float3(1.0, 0.9, 0.8) * pow(fr, 6.0) * (0.45 + energy * 0.35);

        // Idle: calmer and dimmer; listening: full color.
        float luma = dot(col, float3(0.299, 0.587, 0.114));
        col = mix(float3(luma) * float3(1.0, 0.8, 0.7), col, 0.6 + 0.4 * active);
        col *= 0.55 + 0.45 * active;
    }

    // Outer glow + voice ripples.
    float d = max(r - 1.0, 0.0) * R;
    float3 haloCol = mix(float3(1.0, 0.38, 0.12), float3(1.0, 0.25, 0.35), 0.5 + 0.5 * sin(ang * 2.0 + t * 0.4));
    haloCol = mix(haloCol, float3(1.0, 0.85, 0.7), energy * 0.3);
    float glow = exp(-d * (9.0 - energy * 2.5)) * (0.12 + active * 0.16 + energy * 0.35);
    float ripples = (0.5 + 0.5 * sin(d * 50.0 - t * 3.0)) * exp(-d * 10.0) * level * 0.18;
    float edgeFade = smoothstep(1.0, 0.7, max(abs(uv.x), abs(uv.y)));
    float halo = (glow + ripples) * (1.0 - body) * edgeFade;
    float3 outer = haloCol * halo;

    // Saturation-preserving highlight roll-off.
    float peak = max(col.r, max(col.g, col.b));
    col = mix(col / max(peak, 1.0), float3(1.0), clamp(peak - 1.0, 0.0, 1.0) * 0.6);
    // Premultiplied alpha.
    return half4(half3(col * body + outer), half(clamp(body + halo, 0.0, 1.0)));
}
