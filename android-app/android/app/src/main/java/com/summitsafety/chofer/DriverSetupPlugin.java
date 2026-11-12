package com.summitsafety.chofer;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Small helpers so the driver page can check and fix phone settings. */
@CapacitorPlugin(
    name = "DriverSetup",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class DriverSetupPlugin extends Plugin {

    private boolean hasPerm(String p) {
        return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject state() {
        Context ctx = getContext();
        JSObject o = new JSObject();
        o.put("locationPermission", hasPerm(Manifest.permission.ACCESS_FINE_LOCATION));
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        o.put("locationOn", lm != null && LocationManagerCompat.isLocationEnabled(lm));
        boolean batteryOk = true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null) batteryOk = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        o.put("batteryOk", batteryOk);
        o.put("notificationsOk", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("manufacturer", Build.MANUFACTURER);
        o.put("version", BuildConfig.VERSION_NAME);
        o.put("versionCode", BuildConfig.VERSION_CODE);
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) { call.resolve(state()); return; }
        requestPermissionForAlias("location", call, "permDone");
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) openAppSettingsIntent();
            call.resolve(state());
            return;
        }
        requestPermissionForAlias("notifications", call, "permDone");
    }

    @PermissionCallback
    private void permDone(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestBattery(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) {}
        }
        call.resolve(state());
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) {}
        call.resolve(state());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        openAppSettingsIntent();
        call.resolve(state());
    }

    private void openAppSettingsIntent() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) {}
    }
}
