package at.takweb.eud;

import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// for the start page (scanned TAKweb QR code) and the EUD (change server): only a real TAKweb server is taken,
// then the app starts again on it
@CapacitorPlugin(name = "TakWeb")
public class TakWebPlugin extends Plugin {

    @PluginMethod
    public void setServer(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            MainActivity.forget(getContext());
            call.resolve();
            getActivity().runOnUiThread(() -> getActivity().recreate());
            return;
        }
        Uri u = Uri.parse(url);
        if (!"https".equals(u.getScheme()) || u.getHost() == null) {
            call.reject("Only https addresses are possible.");
            return;
        }
        new Thread(() -> {
            if (!MainActivity.isTakWeb(url)) {
                call.reject("No TAKweb server at " + u.getHost() + ".");
                return;
            }
            MainActivity.remember(getContext(), url);
            call.resolve();
            getActivity().runOnUiThread(() -> getActivity().recreate());
        }).start();
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("server", getContext().getSharedPreferences(MainActivity.PREFS, android.content.Context.MODE_PRIVATE).getString("server", null));
        r.put("version", BuildConfig.VERSION_NAME);
        call.resolve(r);
    }
}
