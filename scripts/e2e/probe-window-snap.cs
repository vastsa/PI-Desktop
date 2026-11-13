using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Drawing;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public struct SnapRect { public int Left, Top, Right, Bottom; }
public struct SnapPoint { public int X, Y; }
public struct SnapMouseInput { public int x,y; public uint data,flags,time; public UIntPtr extra; }
public struct SnapInput { public uint type; public SnapMouseInput mouse; }
public static class WindowSnapProbe {
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out SnapRect r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out SnapRect r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref SnapPoint p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out SnapPoint p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count, SnapInput[] input, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr dc,int index);
    [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out SnapRect r, int size);
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string RunId = Guid.NewGuid().ToString("N");
    static readonly Dictionary<string, object> Result = new Dictionary<string, object>();
    static int sequence, pointerSequence, checks;
    static bool externalPointer;
    static void Log(string message) { File.AppendAllText(FilePath("probe.log"),DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine); }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
    static string FilePath(string name) { return Path.Combine(Root, name); }
    static int Number(Dictionary<string, object> value, string key) { return Convert.ToInt32(value[key]); }
    static Dictionary<string, object> Read(string name) {
        if (!File.Exists(FilePath(name))) return null;
        try {
            using(var stream=new FileStream(FilePath(name),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
            using(var reader=new StreamReader(stream)) return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
        catch (FileNotFoundException) { return null; }
        catch (ArgumentException) { return null; }
    }
    static void Wait(Func<bool> predicate, string message, int milliseconds = 5000) {
        var clock = Stopwatch.StartNew();
        Application.DoEvents();
        while (!predicate()) {
            if (File.Exists(FilePath("fixture-error.txt"))) throw new Exception(File.ReadAllText(FilePath("fixture-error.txt")));
            if (clock.ElapsedMilliseconds > milliseconds) throw new Exception(message);
            Application.DoEvents(); Thread.Sleep(25);
        }
    }
    static SnapRect Rect(IntPtr window) { SnapRect rect; Check(GetWindowRect(window, out rect), "read window bounds"); return rect; }
    static Dictionary<string, object> Bounds(IntPtr window) {
        var r = Rect(window); SnapRect client, visible; var origin = new SnapPoint();
        Check(GetClientRect(window, out client) && ClientToScreen(window, ref origin), "read client bounds");
        Check(DwmGetWindowAttribute(window, 9, out visible, 16) >= 0, "read DWM visible frame");
        return new Dictionary<string, object> {
            {"x",r.Left},{"y",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top},
            {"clientX",origin.X},{"clientY",origin.Y},{"clientWidth",client.Right},{"clientHeight",client.Bottom},
            {"visibleX",visible.Left},{"visibleY",visible.Top},{"visibleWidth",visible.Right-visible.Left},{"visibleHeight",visible.Bottom-visible.Top},
            {"style","0x"+GetWindowLong(window,-16).ToString("X8")}
        };
    }
    static bool IsRect(IntPtr window, int x, int y, int width, int height) {
        SnapRect r; return GetWindowRect(window,out r) && r.Left==x && r.Top==y && r.Right-r.Left==width && r.Bottom-r.Top==height;
    }
    static void Focus(IntPtr window) {
        var r = Rect(window);
        if(externalPointer) Pointer("click",r.Left+250,r.Top+100,0,0);
        else {SetCursorPos(r.Left+250,r.Top+100);InjectMouse(2);InjectMouse(4);}
        Wait(() => GetForegroundWindow()==window,"fixture did not receive real foreground input");
        Application.DoEvents(); Thread.Sleep(80);
    }
    static void Key(IntPtr window, byte key) {
        Focus(window);
        try { keybd_event(0x5b,0,0,UIntPtr.Zero); keybd_event(key,0,0,UIntPtr.Zero); Thread.Sleep(60); }
        finally { keybd_event(key,0,2,UIntPtr.Zero); keybd_event(0x5b,0,2,UIntPtr.Zero); }
    }
    static void WriteCommand(string json) {
        var temporary=FilePath("command.json.tmp");
        File.WriteAllText(temporary,json);
        var destination=FilePath("command.json");
        if(File.Exists(destination))File.Delete(destination);
        File.Move(temporary,destination);
    }
    static Dictionary<string, object> Command(string action, bool value = false) {
        Log("window command: "+action+" "+value);
        int id=++sequence;
        WriteCommand(Json.Serialize(new Dictionary<string,object>{{"id",id},{"action",action},{"value",value}}));
        Dictionary<string,object> state=null;
        Wait(() => { state=Read("state.json"); return state!=null && Number(state,"id")==id; },"fixture command timed out: "+action,15000);
        return state;
    }
    static void Drag(int x, int y, int endX, int endY) {
        if(externalPointer) {Pointer("drag",x,y,endX,endY);return;}
        Log("native drag from "+x+","+y+" to "+endX+","+endY);
        MovePointer(x,y); Application.DoEvents(); Thread.Sleep(80); InjectMouse(2); Application.DoEvents(); Thread.Sleep(50);
        try {
            Check((GetAsyncKeyState(1)&0x8000)!=0,"physical mouse down was not registered");
            for(int step=1;step<=12;step++){MovePointer(x+(endX-x)*step/12,y+(endY-y)*step/12);Application.DoEvents();Thread.Sleep(50);}
        }
        finally { InjectMouse(4); }
    }
    static void Pointer(string action, int x, int y, int endX, int endY) {
        int id=++pointerSequence;
        File.WriteAllText(FilePath("pointer-request.json"),Json.Serialize(new Dictionary<string,object>{{"runId",RunId},{"id",id},{"action",action},{"x",x},{"y",y},{"endX",endX},{"endY",endY}}));
        Dictionary<string,object> response=null;
        Wait(() => {response=Read("pointer-response.json");return response!=null && Number(response,"id")==id && (string)response["runId"]==RunId;},"external pointer adapter did not acknowledge input",30000);
        Check(response.ContainsKey("ok") && (bool)response["ok"],"external pointer input failed");
    }
    static void InjectMouse(uint flags, uint x=0, uint y=0) {
        var input=new SnapInput();input.mouse.x=(int)x;input.mouse.y=(int)y;input.mouse.flags=flags;
        Check(SendInput(1,new[]{input},Marshal.SizeOf(typeof(SnapInput)))==1,"native mouse input was rejected");
    }
    static void MovePointer(int x, int y) {
        Check(SetCursorPos(x,y),"native cursor movement was rejected");
        InjectMouse(0x2001); // Queue a non-coalesced move at the verified screen point.
        SnapPoint actual=new SnapPoint();
        Wait(() => GetCursorPos(out actual) && actual.X==x && actual.Y==y,"native cursor did not reach the requested screen point");
    }
    static void Pixels(IntPtr window, string label, bool clientOnly = false) {
        Focus(window); var r=Rect(window); int width=r.Right-r.Left,height=r.Bottom-r.Top;
        if(clientOnly) {
            SnapRect client;var origin=new SnapPoint();
            Check(GetClientRect(window,out client) && ClientToScreen(window,ref origin),"read maximized pixels");
            r.Left=origin.X;r.Top=origin.Y;width=client.Right;height=client.Bottom;
        }
        Log("checking pixels: "+label);
        using(var bitmap=new Bitmap(width,height)) using(var graphics=Graphics.FromImage(bitmap)) {
            string mismatch="";
            try {
                // DWM reports target bounds before its snap animation finishes.
                Wait(() => {
                    graphics.CopyFromScreen(r.Left,r.Top,0,0,bitmap.Size);
                    foreach(var point in new[]{new Point(0,height/2),new Point(1,height/2),new Point(width-1,height/2),new Point(width-2,height/2),new Point(width/4,height-1),new Point(width*3/4,height-1)}) {
                        var actual=bitmap.GetPixel(point.X,point.Y); int expected=point.X<width/2?246:24;
                        if(Math.Abs(actual.R-expected)>3 || Math.Abs(actual.G-expected)>3 || Math.Abs(actual.B-expected)>3) {
                            mismatch=point+": "+actual; return false;
                        }
                    }
                    return true;
                },label+" client edge never reached its renderer colors");
                Check(true,label+" has no painted native rim");
            } catch(Exception error) {throw new Exception(label+" painted edge: "+mismatch,error);}
            finally {bitmap.Save(FilePath(label+".png"));}
        }
    }
    static void ClientEqualsWindow(IntPtr window) {
        var b=Bounds(window);
        Check(Number(b,"x")==Number(b,"clientX") && Number(b,"y")==Number(b,"clientY") && Number(b,"width")==Number(b,"clientWidth") && Number(b,"height")==Number(b,"clientHeight"),"native frame insets returned");
    }
    static void Maximized(IntPtr window, Dictionary<string,object> area, string label) {
        var b=Bounds(window); Result[label]=b;
        Check(Number(b,"clientX")==Number(area,"x") && Number(b,"clientY")==Number(area,"y") && Number(b,"clientWidth")==Number(area,"width") && Number(b,"clientHeight")==Number(area,"height"),label+" client extends beyond the work area");
        Check(Number(b,"visibleX")==Number(area,"x") && Number(b,"visibleY")==Number(area,"y") && Number(b,"visibleWidth")==Number(area,"width") && Number(b,"visibleHeight")==Number(area,"height"),label+" visible frame extends beyond the work area");
        Pixels(window,label,true);
    }
    [STAThread] public static void Main() {
        Process child=null; SnapPoint pointer; bool saved=GetCursorPos(out pointer);
        System.Threading.Tasks.Task<string> stdout=null,stderr=null;
        NativeWindow foreign=new NativeWindow();
        try {
            Result["runId"]=RunId;Result["startedAt"]=DateTime.UtcNow.ToString("o");
            Result["sessionId"]=Process.GetCurrentProcess().SessionId;
            Log("starting native snap acceptance");
            Check(Process.GetCurrentProcess().SessionId>0,"an interactive Windows session is required; session 0 is unsupported");
            var desktop=OpenInputDesktop(0,false,0x101);
            Check(desktop!=IntPtr.Zero,"the interactive input desktop is unavailable or locked");
            CloseDesktop(desktop);
            var dc=GetDC(IntPtr.Zero);
            try { Result["desktopBitsPerPixel"]=GetDeviceCaps(dc,12)*GetDeviceCaps(dc,14); }
            finally { ReleaseDC(IntPtr.Zero,dc); }
            bool composition;Result["dwmCompositionResult"]=DwmIsCompositionEnabled(out composition);Result["dwmComposition"]=composition;
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            var options=Read("options.json"); bool baseline=(bool)options["baseline"];
            externalPointer=options.ContainsKey("externalPointer") && (bool)options["externalPointer"];
            Result["pointerInput"]=externalPointer?"external":"native";
            var parameters=new CreateParams(); parameters.Style=unchecked((int)0x80000000); parameters.Width=1; parameters.Height=1;
            foreign.CreateHandle(parameters); int originalStyle=GetWindowLong(foreign.Handle,-16);
            foreach(var name in new[]{"result.json","ready.json","state.json","command.json","fixture-error.txt","pointer-request.json","pointer-response.json"}) File.Delete(FilePath(name));
            string electron=(string)options["electronBinary"]; if(!Path.IsPathRooted(electron))electron=FilePath(electron);
            var info=new ProcessStartInfo(electron,"\""+FilePath("main.cjs")+"\" "+(baseline?"--baseline ":"")+"--foreign-handle="+foreign.Handle.ToInt64()+" --user-data-dir=\""+FilePath("electron-profile")+"\"");
            info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
            child=Process.Start(info); stdout=child.StandardOutput.ReadToEndAsync(); stderr=child.StandardError.ReadToEndAsync();
            Dictionary<string,object> ready=null;
            Wait(() => {ready=Read("ready.json");return ready!=null;},"fixture startup timed out",45000);
            var window=new IntPtr(long.Parse((string)ready["nativeHandle"])); uint owner;
            GetWindowThreadProcessId(window,out owner); Check(owner==(uint)Number(ready,"processId") && owner==child.Id,"fixture handle owner mismatch");
            Check(GetWindowLong(foreign.Handle,-16)==originalStyle,"foreign window style was modified");
            var area=(Dictionary<string,object>)ready["workArea"]; int x=Number(area,"x"),y=Number(area,"y"),half=Number(area,"width")/2,height=Number(area,"height");
            Check(half>=Number(options,"minWidth"),"work-area half is smaller than the nominal minimum width");
            Result["baseline"]=baseline;Result["environment"]=ready;Result["before"]=Bounds(window);
            Log("checking Win+Left");
            Key(window,0x25); Thread.Sleep(300); Result["left"]=Bounds(window);
            Wait(() => IsRect(window,x,y,half,height),"Win+Left did not snap to the work-area half"); ClientEqualsWindow(window);Pixels(window,"left");
            Command("reset"); Key(window,0x27);
            Wait(() => IsRect(window,x+half,y,Number(area,"width")-half,height),"Win+Right did not snap to the work-area half");Result["right"]=Bounds(window);ClientEqualsWindow(window);Pixels(window,"right");
            Command("reset");Focus(window); var normal=Rect(window);
            Check(SendMessage(window,0x84,IntPtr.Zero,new IntPtr(((normal.Top+22)<<16)|((normal.Left+250)&0xffff))).ToInt64()==2,"titlebar does not expose native HTCAPTION");
            Drag(normal.Left+250,normal.Top+22,x,y+height/2);
            Result["dragLeft"]=Bounds(window);
            Wait(() => IsRect(window,x,y,half,height),"titlebar drag did not snap to the work-area half");Result["dragLeft"]=Bounds(window);ClientEqualsWindow(window);
            Command("reset");Pixels(window,"normal");normal=Rect(window);
            Drag(normal.Right-1,normal.Top+height/3,normal.Right+99,normal.Top+height/3);
            Wait(() => Rect(window).Right-Rect(window).Left>=1290,"native right edge did not resize");Result["resized"]=Bounds(window);ClientEqualsWindow(window);Pixels(window,"resized");
            Command("reset");normal=Rect(window);Drag(normal.Left+1,normal.Top+300,normal.Right-10,normal.Top+300);
            Wait(() => Rect(window).Right-Rect(window).Left==Number(options,"minWidth"),"native minimum width was not enforced");Result["minimumWidth"]=Bounds(window);
            Command("reset");normal=Rect(window);Drag(normal.Left+300,normal.Bottom-1,normal.Left+300,normal.Top+10);
            Wait(() => Rect(window).Bottom-Rect(window).Top==Number(options,"minHeight"),"native minimum height was not enforced");Result["minimumHeight"]=Bounds(window);
            Command("reset");Key(window,0x26);Command("snapshot");Maximized(window,area,"keyboardMaximized");
            Key(window,0x28);Wait(() => IsRect(window,200,140,1200,800),"Win+Down did not restore the normal window");
            Key(window,0x28);Wait(() => IsIconic(window),"Win+Down did not minimize the normal window");Command("restore");
            Command("reset");Command("maximize");Maximized(window,area,"maximized");
            Command("minimize");Command("restore");Maximized(window,area,"restoredMaximized");
            Command("unmaximize");ClientEqualsWindow(window);Pixels(window,"restored");
            var state=Command("fullscreen",true);Check((bool)state["fullscreen"],"fullscreen state was lost");
            var display=(Dictionary<string,object>)ready["displayBounds"];
            Wait(() => IsRect(window,Number(display,"x"),Number(display,"y"),Number(display,"width"),Number(display,"height")),"fullscreen does not fill the display");
            Result["fullscreen"]=Bounds(window);
            Command("fullscreen",false);ClientEqualsWindow(window);Pixels(window,"after-fullscreen");
            Key(window,0x25);Wait(() => IsRect(window,x,y,half,height),"snapping was lost after fullscreen");
            Result["afterFullscreenSnap"]=Bounds(window);
            Result["ok"]=true;
            WriteCommand("{\"action\":\"quit\"}");
            Check(child.WaitForExit(10000),"fixture did not retire its Host");
        } catch(Exception error) {Result["ok"]=false;Result["failure"]=error.Message;Result["error"]=error.ToString();Log("failed: "+error.Message);}
        finally {
            if(child!=null && !child.HasExited){
                WriteCommand("{\"action\":\"quit\"}");
                if(!child.WaitForExit(10000)){
                    var kill=Process.Start(new ProcessStartInfo("taskkill.exe","/PID "+child.Id+" /T /F"){UseShellExecute=false,CreateNoWindow=true});
                    kill.WaitForExit(10000);child.WaitForExit(5000);
                }
            }
            if(stdout!=null)File.WriteAllText(FilePath("stdout.txt"),stdout.Wait(5000)?stdout.Result:"stdout collection timed out");
            if(stderr!=null)File.WriteAllText(FilePath("stderr.txt"),stderr.Wait(5000)?stderr.Result:"stderr collection timed out");
            foreign.DestroyHandle();if(saved)SetCursorPos(pointer.X,pointer.Y);
            Result["checks"]=checks;Result["finishedAt"]=DateTime.UtcNow.ToString("o");
            File.WriteAllText(FilePath("result.json"),Json.Serialize(Result));Log("completed: "+Result["ok"]+" checks="+checks);
        }
    }
}
