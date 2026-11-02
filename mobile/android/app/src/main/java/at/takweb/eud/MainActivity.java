package at.takweb.eud;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

// TAKweb for Android: one app for every TAKweb server. The server comes from the invitation (takweb://open?u=…,
// "Open in the TAKweb app" on the access page) or a scanned TAKweb QR code, and becomes the app's start address –
// only there Capacitor puts its plugins (background location, Bluetooth) into the page.
// Safety: only a real TAKweb server is taken (checked at /api/eud/app), and a link to ANOTHER server is only
// followed after the user confirmed it – any web page can offer a takweb:// link.
public class MainActivity extends BridgeActivity {

    static final String PREFS = "takweb";
    private boolean errorShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TakWebPlugin.class);
        String link = linkOf(getIntent());
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // the full invitation link (with the login) only once, afterwards the server's EUD address
        String once = prefs.getString("once", null);
        String start = once != null ? once : prefs.getString("server", null);
        if (once != null) prefs.edit().remove("once").apply();
        if (start != null) {
            Uri u = Uri.parse(start);
            config = new CapConfig.Builder(this)
                .setServerUrl(start)
                .setAllowNavigation(new String[] { u.getHost() })
                .setAndroidScheme("https")
                .create();
        }
        super.onCreate(savedInstanceState);
        if (start != null) watchLoadErrors(Uri.parse(start).getHost());
        if (start != null && !prefs.getBoolean("checked", false)) checkSaved(start); // saved by the first app version
        if (link != null) handleLink(link);
    }

    // a server from before the check (first app version, any address could be entered): check it once
    private void checkSaved(final String start) {
        new Thread(() -> {
            final Boolean ok = probe(start);
            if (ok == null) return; // not reachable (e.g. offline): keep it, check again at the next start
            runOnUiThread(() -> {
                if (ok) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("checked", true).apply();
                    return;
                }
                if (isFinishing()) return;
                forget(this);
                new AlertDialog.Builder(this)
                    .setTitle("Not a TAKweb server")
                    .setMessage(Uri.parse(start).getHost() + " is not a TAKweb server. Scan the TAKweb QR code or open the invitation again.")
                    .setCancelable(false)
                    .setPositiveButton("OK", (d, w) -> recreate())
                    .show();
            });
        }).start();
    }

    // app already open and an invitation link is tapped
    @Override
    protected void onNewIntent(Intent intent) {
        String link = linkOf(intent);
        if (link != null) {
            handleLink(link);
            return;
        }
        super.onNewIntent(intent);
    }

    // takweb://open?u=<https link>; the intent loses its data so it is not handled twice
    private static String linkOf(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null || !"takweb".equals(data.getScheme())) return null;
        intent.setData(null);
        String u = data.getQueryParameter("u");
        Uri p = u != null ? Uri.parse(u) : null;
        return p != null && "https".equals(p.getScheme()) && p.getHost() != null ? u : null;
    }

    private void handleLink(String url) {
        final String host = Uri.parse(url).getHost();
        final String current = savedHost(this);
        new Thread(() -> {
            final boolean ok = isTakWeb(url);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (!ok) {
                    new AlertDialog.Builder(this)
                        .setTitle("Not a TAKweb server")
                        .setMessage(host + " is not a TAKweb server (or not reachable). The app stays as it is.")
                        .setPositiveButton("OK", null)
                        .show();
                    return;
                }
                if (host.equalsIgnoreCase(current)) { // the same server (e.g. a new login): no question
                    remember(this, url);
                    recreate();
                    return;
                }
                new AlertDialog.Builder(this)
                    .setTitle("Connect to this TAKweb server?")
                    .setMessage(host + "\n\nOnly confirm invitations from your administrator. The app then opens this server.")
                    .setPositiveButton("CONNECT", (d, w) -> { remember(this, url); recreate(); })
                    .setNegativeButton("CANCEL", null)
                    .show();
            });
        }).start();
    }

    // server not reachable (no network, server down, wrong address): retry or choose another one – never stuck
    private void watchLoadErrors(final String host) {
        if (bridge == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (!request.isForMainFrame() || errorShown || isFinishing()) return;
                errorShown = true;
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("TAKweb server not reachable")
                    .setMessage(host + "\n\n" + error.getDescription())
                    .setCancelable(false)
                    .setPositiveButton("RETRY", (d, w) -> { errorShown = false; view.loadUrl(bridge.getAppUrl()); })
                    .setNegativeButton("OTHER SERVER", (d, w) -> { forget(MainActivity.this); recreate(); })
                    .show();
            }
        });
    }

    // a real TAKweb server answers /api/eud/app with {"takweb": true}
    static boolean isTakWeb(String url) {
        return Boolean.TRUE.equals(probe(url));
    }

    // TRUE = TAKweb server, FALSE = answers but is no TAKweb server, null = not reachable
    static Boolean probe(String url) {
        HttpURLConnection c = null;
        int code;
        try {
            Uri u = Uri.parse(url);
            c = (HttpURLConnection) new URL("https://" + u.getEncodedAuthority() + "/api/eud/app").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            code = c.getResponseCode();
        } catch (Exception e) {
            if (c != null) c.disconnect();
            return null;
        }
        try {
            if (code != 200) return false;
            StringBuilder b = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null && b.length() < 4096) b.append(line);
            }
            return new JSONObject(b.toString()).optBoolean("takweb", false);
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String savedHost(Context ctx) {
        String s = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("server", null);
        return s != null ? Uri.parse(s).getHost() : null;
    }

    static void remember(Context ctx, String url) {
        Uri u = Uri.parse(url);
        String base = "https://" + u.getEncodedAuthority() + "/eud/";
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("server", base).putString("once", url).putBoolean("checked", true).apply();
    }

    static void forget(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("server").remove("once").remove("checked").apply();
    }
}
