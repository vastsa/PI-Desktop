import type { ChangelogEntry } from "./changelog.js";

export const trEntries: ChangelogEntry[] = [
  {
    "version": "0.14.6",
    "date": "2026-09-10",
    "highlights": [
      "Bu sürüm yerel verilerinizden eskiyse veya Apple Silicon üzerinde Intel sürümü çalışıyorsa sessizce başarısız olmak yerine uyarır.",
      "Yerel bir MCP masaüstü denetim düzlemi ekler; incelenmiş eklentiler masaüstünü yalnızca yerel onaydan sonra yönetir.",
      "Alt ajan ön ayar şablonları, sağlayıcıya bağlı model seçici ve yetkilendirme kartlarında etkin düşünme düzeyi ekler.",
      "Yapılandırılmış modellere takma ad verin, model kimliklerini kopyalayın ve modelin kendi API biçimini sağlayıcı geneli stile tercih edin.",
      "Edit aracındaki metin eşlemeyi satıra bağlı işlemlerle değiştirir ve hataya özel kurtarma rehberliği sunar.",
      "Sağlayıcıları görünür geri sayımla on kereye kadar yeniden dener ve yalnızca ilerleme içeren otonom turları kurtarır.",
      "macOS yükleyicisini yeniden tasarlar, Windows taşınabilir exe ve Linux RPM paketi ekler, GNOME tepsi ve dock simgelerini geri getirir.",
      "Kenar çubuğundan konuşma kimliklerini kopyalayın ve oturum klasörlerini açın; yalnızca simgeli eylemlerde yerelleştirilmiş ipuçları.",
      "Etkinlik satırında canlı süreç durumu ve sessiz aralıkları gösterir, görünüm alanına sabit bir çalışma paneli anahtarı ekler.",
      "Çalışma alanı yok sayma kurallarını uygular, kopuk sembolik bağlantıları çözer ve her yönlendirmede eklenti ağ çıkışını yeniden denetler.",
      "Proxy atlama kurallarına uyar, yapıştırılan özel kullanım glifleri korur ve dosya önizlemelerini düzenleyiciyi engellemeden yükler.",
    ],
  },
  {
    "version": "0.14.5",
    "date": "2026-09-09",
    "highlights": [
      "Her macOS DMG ve ZIP indirmesini yerel arm64 veya x64 mimarisiyle açıkça etiketleyin."
    ]
  },
  {
    "version": "0.14.4",
    "date": "2026-09-09",
    "highlights": [
      "Eklentiler için sınırlı büyük dosya aralığı okumaları ve gerçek sürükle-bırak hareketlerine bağlı dosya izinleri ekleyin.",
      "macOS imzalama ve noter onayını açıkça seçilebilir hale getirin ve güvenilir imzasız derlemeleri açma yönergeleri ekleyin."
    ]
  },
  {
    "version": "0.14.3",
    "date": "2026-09-09",
    "highlights": [
      "Intel macOS indirmelerini açıkça etiketleyerek yükleyici mimarisini anlaşılır hale getirin."
    ]
  },
  {
    "version": "0.14.2",
    "date": "2026-09-08",
    "highlights": [
      "Seçili modeli izleyen ve sıkıştırma yönergelerini gösteren bir bağlam kullanımı denetçisi ekleyin.",
      "Aranabilir seçim, toplu işlemler ve daha anlaşılır getirme hatalarıyla sağlayıcı ve model ayarlarını geliştirin.",
      "Oturum başlıklarını otomatik olarak özetleyin ve yeniden başlatmalar arasında korunan proje adlarına izin verin.",
      "Canlı durum, kompakt görev baloncukları, model kimliği ve en yeni çıktıya gitme özelliğiyle alt aracı panelini geliştirin.",
      "Etkileşimli sorular ve onaylar için yerel bildirimler gönderin; normal tamamlanmaları gelen kutusunun dışında tutun.",
      "Korece arayüz yerelleştirmesi ekleyin ve yerelleştirilmiş ayarları, pano geçmişini ve güvenli bağlantı işlemeyi geliştirin.",
    ]
  },
  {
    "version": "0.14.1",
    "date": "2026-09-08",
    "highlights": [
      "Delegasyon modeli yapılandırılmadığında alt aracıların üst modelden miras almasını sağlayın.",
      "Üst model kimliklerinin kullanılamayan delegasyon modelleri olarak yanlışlıkla reddedilmesini önleyin.",
    ]
  },
  {
    "version": "0.14.0",
    "date": "2026-09-08",
    "highlights": [
      "Doğrulama ve desteklenmeyen SOCKS4 kimlik bilgilerinin açıkça ele alınmasıyla, sağlayıcı başına giden HTTP proxy’lerini yapılandırın.",
      "CC Switch ve yerel aracı depolarından sağlayıcı profillerini ve model yapılandırmalarını içe aktarın.",
      "Özel sağlayıcı üst bilgileri ve User-Agent ayarları ekleyin; ayrıca MiniMax ön ayarı ve daha anlaşılır model getirme hataları kullanın.",
      "Birleşik seçiciden dosya ekleyin; oturum taslağı kopyalarını ve satır içi görüntü desteğini kullanın.",
      "Geleneksel Çince, Almanca, İspanyolca ve Fransızca arayüzlerin yanı sıra aranabilir görünüm ve sağlayıcı ayarları ekleyin.",
      "Okuma yazı boyutlarını, tipografiyi ve simgeleri tutarlı biçimde ayarlayın; yetkilendirme kartlarında seçili alt aracının modelini gösterin.",
    ]
  },
  {
    "version": "0.13.11",
    "date": "2026-09-07",
    "highlights": [
      "Eklentilerin modelleri listelemesine, oturum içi oturum bağlamını okumasına ve kimlik bilgileri almadan ana bilgisayarın sahip olduğu tamamlamaları talep etmesine izin verin."
    ]
  },
  {
    "version": "0.13.10",
    "date": "2026-09-07",
    "highlights": [
      "Yanlışlıkla veri kaybını önlemek için çıkmadan önce (Cmd+Q, tepsi veya menü) onaylayın."
    ]
  },
  {
    "version": "0.13.9",
    "date": "2026-09-06",
    "highlights": [
      "Sürüm altyapısı için sürüm artışı."
    ]
  },
  {
    "version": "0.13.8",
    "date": "2026-09-06",
    "highlights": [
      "Resimler de dahil olmak üzere proje dosyalarını arayın ve önizleyin, ardından bunları özel bir görüntüleyici sayfasından varsayılan uygulamayla açın.",
      "Çalışma paneli Tarayıcısını, diğer eklenti görünümleriyle aynı izolasyona sahip, paketlenmiş bir eklenti olarak çalıştırın.",
      "Enter'dan sonra @ dosya çiplerini tutun ve planlama sırasında mod çipine darbe verin.",
      "Sohbet, eklentiler ve önizlemelerden yalnızca http(ler) ve mailto bağlantılarını açın."
    ]
  },
  {
    "version": "0.13.7",
    "date": "2026-09-06",
    "highlights": [
      "Yalnızca kullanıcı mesajlarını göstermek yerine, yeniden başlatma sonrasında tamamlanmış AI yanıtlarını koruyun.",
      "Siz onları durdurana veya üst öğe onları durdurana kadar arka plan alt aracılarını çalışır durumda tutun.",
      "Aracının altı saate kadar bir Bash zaman aşımı seçmesine izin verin, böylece uzun işler 60 saniyede sonlandırılmaz."
    ]
  },
  {
    "version": "0.13.6",
    "date": "2026-09-06",
    "highlights": [
      "Yapıştırılan dosya kullanıcı iletilerinin boyutunu, ileti dizisi boyunca uzatmak yerine içeriğine uygun şekilde tutun."
    ]
  },
  {
    "version": "0.13.5",
    "date": "2026-09-06",
    "highlights": [
      "A2A aracısını ve eşler arası konuşma araçlarını kaldırın.",
      "A2A'nın kaldırılmasından sonra bozulan aracı çalışma zamanı testlerini düzeltin."
    ]
  },
  {
    "version": "0.13.4",
    "date": "2026-09-05",
    "highlights": [
      "Ayarlar → Genel'e Türkçe ve aranabilir bir dil seçici ekleyin.",
      "Temayı, eklenti temaları da dahil olmak üzere dil gibi aranabilir bir seçici haline getirin.",
      "Ekleme sağlayıcısı Hizmet listesini düzleştirin, Xiaomi, Zhipu ve Z.AI'yi ekleyin ve Hizmeti aranabilir hale getirin.",
      "Ayarlar → Sürüm ve işletim sistemi bilgilerinin önceden doldurulmuş olduğundan sorunu bildirin.",
      "Canlı transkript birleştiğinde akıştaki konuşmanın kronolojik sıraya göre değişmesini sağlayın."
    ]
  },
  {
    "version": "0.13.3",
    "date": "2026-09-05",
    "highlights": [
      "Önceki transkripti ekranda tutmadan Yeni Görevi hemen boş bir hedefe açın.",
      "Doldurulmuş bir Okuma penceresini tamamlanmış olarak değerlendirin ve kesilmiş çipi gerçek kesmeler için saklayın.",
      "Eski bir arşivi geri yüklemek yerine, yeniden oluşturulan varyantlar arasında geçiş yaparken daha sonraki konuşmaları koruyun."
    ]
  },
  {
    "version": "0.13.2",
    "date": "2026-09-05",
    "highlights": [
      "Giriş yeniden bağlandığında veya pencere gizlendiğinde, dosya çipleri de dahil olmak üzere gönderilmemiş besteci taslaklarını saklayın.",
      "Her zaman en güçlü olanı kullanmak yerine, yeni oturumları model bağlamanın varsayılan düşünme düzeyinde başlatın.",
      "Yukarı kaydırdıktan sonra en yeniye atlama kontrolüyle, genişletilmiş alt aracı çalıştırmalarını en son çıktıya kaydırılmış halde tutun.",
      "Bir dönüş yapılırken bir seviyeyi sabitlerken düşünme seviyesi menüsünü kullanılabilir durumda tutun.",
      "Ekleme sağlayıcı alanlarının tamamen görünür olmasını ve dar bir pencerede odaklanmasını sağlayın.",
      "Pencerenin artık opak bir panel olarak yanıp sönmemesi için macOS başlangıç ​​ekranını kenar çubuğu camıyla eşleştirin."
    ]
  },
  {
    "version": "0.13.1",
    "date": "2026-09-05",
    "highlights": [
      "Atomik eklenti çiplerini besteci giriş satırına üç satırlık varsayılan yükseklikle ekleyin.",
      "Kontrol noktası akışı yanıtları verir, böylece transkripti yeniden yazmadan bırakılma, sepet kaybı ve Durma durumlarında hayatta kalırlar.",
      "Başarılı tamamlamaları bildirim gelen kutusunda gizleyin.",
      "Akış içi kenarlıkları ve bölücüleri kaldırın ve kaydırma çubuklarını yalnızca fareyle üzerine gelindiğinde veya kaydırma sırasında gösterin.",
      "Boş ana ekranda açık ve koyu GIF maskotlarını oynatın."
    ]
  },
  {
    "version": "0.13.0",
    "date": "2026-09-04",
    "highlights": [
      "Kenar çubuğu oturum satırlarına, çalışma alanını, şubeyi ve güncelleme zamanını gösteren zengin bir vurgulu kart ekleyin.",
      "Daha derin cam derinliği için macOS kenar çubuğunu pencere altı canlılık malzemesine değiştirin.",
      "Kenarlıksız bir cam kenar için macOS kenar çubuğu yerleştirme dikişini çıkarın.",
      "Boş ana ekranda temaya özel sekiz kareli el sallayan maskotları oynatın.",
      "İlk oluşturmada ileri referanslı bir değişkenin neden olduğu kenar çubuğu çökmesini düzeltin."
    ]
  },
  {
    "version": "0.12.4",
    "date": "2026-09-04",
    "highlights": [
      "MainChat'in sol kenar çubuğu gibi yeniden akması için sağ çalışma panelini uygulama penceresinin içinde tutun.",
      "Pencere sınırlarını koruyarak çalışma panelini işaretçi veya klavye kontrolleriyle iç bölmesinden yeniden boyutlandırın.",
      "Daha sorunsuz gezinme için oturum değiştirme sırasında sayfalanmış transkript okumalarını tekilleştirin.",
      "Kenar çubuğunun düzen davranışını değiştirmeden yerel bir macOS kenar çubuğu yüzey işlemi ekleyin."
    ]
  },
  {
    "version": "0.12.3",
    "date": "2026-09-03",
    "highlights": [
      "Seçilen modelin yayınlanan içerik penceresine göre içerik kullanımını göster.",
      "Modele özgü bağlam sınırlarının sağlayıcı ayarları, Oluşturucu ve çalışma zamanı genelinde tutarlı olmasını sağlayın.",
      "Modelleri değiştirirken ve etkin dönüşler sırasında Composer bağlamsal rehberliğini sabit tutun."
    ]
  },
  {
    "version": "0.12.2",
    "date": "2026-09-03",
    "highlights": [
      "Ana bilgisayarın gidiş dönüş yolculuğu tamamlanmadan önce görünen kullanıcı mesajı satırını düzeltin.",
      "Eski içeriği önlemek için göndermeden önce taslak istemini temizleyin.",
      "Daha düzgün bir görüntü oluşturma için uzun transkriptleri bir iskelet örtü altına yerleştirin."
    ]
  },
  {
    "version": "0.12.1",
    "date": "2026-09-03",
    "highlights": [
      "Sağlayıcı ayarlarını kaydettikten ve uygulamayı yeniden başlattıktan sonra alt aracı yetkisi için modelleri etkin durumda tutun.",
      "Oturumları yeniden açarken canlı yanıtları görünür tutun."
    ]
  },
  {
    "version": "0.12.0",
    "date": "2026-09-02",
    "highlights": [
      "Eşzamanlı alt aracıları Agent2Agent (A2A) protokolü üzerinden koordine edin: Çalışan eşleri Ajan Kartları olarak keşfedin, dayanıklı görevleri ve yazılan mesajları paylaşın ve görev güncellemelerini yayınlayın; bu, önceki işlem içi eş mesajlaşmanın yerini alır."
    ]
  },
  {
    "version": "0.11.4",
    "date": "2026-09-01",
    "highlights": [
      "Apple Silicon yapılarının yanı sıra yerel macOS Intel DMG ve ZIP yükleyicilerini yayınlayın.",
      "macOS güncelleyici akışlarını her iki yerel mimaride birleşik tutun."
    ]
  },
  {
    "version": "0.11.3",
    "date": "2026-08-31",
    "highlights": [
      "Her alt aracıya bir temsilci kataloğundan kendi modelini atayın veya ana görüşmenin seçimini devralmasına izin verin.",
      "Eşzamanlı alt aracıların, konu filtreli, iş parçacığı şeklinde eş mesajlaşma yoluyla birbirlerine mesaj göndermesine izin verin.",
      "Birden fazla alt temsilcinin bir konuyu turlar boyunca tartıştığı ve sonucu özetlediği yapılandırılmış yuvarlak masa tartışmaları yürütün.",
      "Model yapılandırma kontrollerini (delegasyon onay kutusu, özel model bölümü ve yazı tipi boyutları) paneller arasında uyumlu hale getirin.",
      "Yetkilendirme ipucu metnini daha temiz bir simge araç ipucuyla değiştirin."
    ]
  },
  {
    "version": "0.11.2",
    "date": "2026-08-31",
    "highlights": [
      "Sohbet alanı yanıp sönmeden son konuşmalar arasında geçiş yapın: her biri kendi bölmesini korur ve kaydırma konumu da dahil olmak üzere tam olarak bıraktığınız gibi yeniden görünür.",
      "Yukarı kaydırdığınız bir görüşmeye dönün ve o noktaya geri dönün; ilk kez açılan bir oturum hâlâ en yeni sırasında başlar.",
      "Yeni bir ileti dizisi yüklenirken, transkripsiyonun soluklaşmasını izlemek yerine mevcut ileti dizisini okumaya devam edin.",
      "Metni değiştirmeden bıraksanız bile, düzenlenmiş bir istemi yeniden deneyin.",
      "Aracının daha eski bir isteği alması yerine, otomatik bağlam sıkıştırmasının ardından elinizdeki görev üzerinde çalışmaya devam edin."
    ]
  },
  {
    "version": "0.11.0",
    "date": "2026-08-30",
    "highlights": [
      "Paket kataloğa geri dönmeden önce AI hizmetinden kendi modellerini isteyen, keşif odaklı tek bir formda bir sağlayıcı ayarlayın.",
      "Models.dev kataloğundan alınan, yetenek rozetlerini ve bağlam boyutunu gösteren, aranabilir bir listeden bir model seçin.",
      "Ek yeteneklerini ve model bağlama başına varsayılan düşünme düzeyini geçersiz kılın ve yalnızca bir modelin yayınladığı düşünme düzeylerini görün.",
      "Yalnız bir alt aracı delegasyonunu yaşam döngüsü satırlarına sahip kendi kartı olarak okuyun ve transkripti genişletmek yerine genişletilmiş bir temsilci çalıştırmasını kaydırın.",
      "Geçmiş yüklenirken konuşma özetini erişilebilir tutun ve oturumlar yüklenirken boş bir liste yerine bir çerçeve görün.",
      "Büyük bir metin bloğunu besteciye yapıştırın ve yazmayı yeniden akış yolunun dışında tutarak bir oturum dosyasına dökmesini sağlayın.",
      "Ekranlar arasında sürüklerken pencereyi bıraktığınız yerde tutun ve başlık çubuğu bandını macOS hedef sayfalarına ayrılmış halde tutun.",
      "Reddedilen dosya ve arama aracı çağrılarına ve milisaniye cinsinden verilen komut zaman aşımına karşı daha az dönüş kaybedersiniz."
    ]
  },
  {
    "version": "0.10.9",
    "date": "2026-08-28",
    "highlights": [
      "Becerileri, alt aracıları ve MCP sunucularını, düzey filtreleri, arama ve onaylanmış kaldırma özellikleriyle Ayarlar'daki tek bir yetenek çalışma tezgahından yönetin.",
      "Doğru boyutlandırılmış araç çubuğu ve boş durum kontrolleriyle, yetenek çalışma tezgahını ve ayarların üst bandını her iki temada da okunabilir tutun.",
      "Kaydırırken, oturumları değiştirirken ve mini harita üzerinde gezinirken, transkriptin yerine oturmasına gerek kalmadan uzun konuşmaların hızlı yanıt vermesini sağlayın.",
      "Geçmiş bir oturumu boş olarak göstermek yerine, eski yapılar tarafından yazılan her transkript satırını yükleyin.",
      "Bir düzenlemeyi yeniden oluştururken veya yeniden gönderirken seçtiğiniz mesajdaki transkripti kesin ve kenar çubuğunda her zaman çatallanmış bir oturumu listeleyin.",
      "Alt aracı canlılığını herhangi bir yanıta göre değerlendirin, her yerleşik alt aracının dönüşlerini sınırlayın ve süresi dolmuş bir beklemeyi başarısız yerine hala çalışıyor olarak rapor edin.",
      "Tur başına bir paylaşılan bütçede 1/2/4/8 saniye beklemeyle geçici bir sağlayıcı arızasını dört defaya kadar yeniden deneyin ve gerçek girişimi akış ortasında rapor edin."
    ]
  },
  {
    "version": "0.10.8",
    "date": "2026-08-26",
    "highlights": [
      "Windows yerel pencere kontrollerini çerçevesiz kabuktaki panel eylemlerinden izole tutun.",
      "Geçici sohbetlere, dosyalarının proje çalışmalarından ayrı kalması için yalıtılmış çalışma alanları verin.",
      "Komut başlatıcıdaki bilgi istemi geliştirmesini daha net bir bot modeli simgesiyle geri yükleyin.",
      "Kenar çubuğu kaydırma çubuklarını hareketsiz durumdayken sessiz tutarken gösterin."
    ]
  },
  {
    "version": "0.10.7",
    "date": "2026-08-25",
    "highlights": [
      "Taslakların ve devam eden dönüşlerin hizalı kalması için Composer'ın gönderme ve durdurma kontrollerini tek bir sabit yuvada tutun.",
      "İstem geliştirmeyi bağımsız bir araç çubuğu simgesi olmadan komut başlatıcıdan kullanılabilir durumda tutun.",
      "Kenar çubuğu kaydırma çubuklarının gezinme sırasında keşfedilebilir kalmasını sağlarken, kullanımda değilken daha sessiz olmasını sağlayın."
    ]
  },
  {
    "version": "0.10.6",
    "date": "2026-08-25",
    "highlights": [
      "Yeni bir oturum oluşturulmadan önce de dahil olmak üzere, Composer'da seçilen tam model için Düşünme yeteneklerini gösterin.",
      "Yeni oturumları seçilen akıl yürütme modelinin yayınlanan en güçlü düzeyinde başlatın."
    ]
  },
  {
    "version": "0.10.5",
    "date": "2026-08-25",
    "highlights": [
      "Windows pencere kontrollerini çerçevesiz kabuktaki panel eylemlerinden izole tutun.",
      "Genişletilmiş uzunluk önekine sahip yollar dahil, Windows proje klasörlerini ve dosyalarını güvenilir bir şekilde açın.",
      "Orijinal satır sonu stilini değiştirmeden CRLF dosyalarını düzenleyin."
    ]
  },
  {
    "version": "0.10.4",
    "date": "2026-08-25",
    "highlights": [
      "Konuşma seçicide yalnızca yapılandırılmış sağlayıcı modellerini göster, bu arada kayıtlı modelleri keşif kullanılamadığında kullanılabilir durumda tut.",
      "Çerçevesiz pencere kontrol bandını opak tutun, böylece sayfa içeriği hiçbir zaman yerel kontroller aracılığıyla gösterilmemelidir.",
      "Çalışma paneli açıkken sohbet genişliğini sabit tutun ve yalnızca sohbet penceresi çöktükten sonra sınırlarını geri yükleyin."
    ]
  },
  {
    "version": "0.10.3",
    "date": "2026-08-25",
    "highlights": [
      "Tek seferlik bilgi istemi iyileştirmesini geliştirerek mevcut taslağın ve dosya referanslarının bozulmadan kalmasını sağlayın.",
      "Bestecinin gönderme ve durdurma eylemlerini görünür taslak ve çalışan oturumla uyumlu tutun.",
      "TaskWait dönüşleri ve oluşturucunun yeniden yüklemeleri sırasında arka plandaki yetki verme meta verilerini koruyun.",
      "Çatallanmış oturumların geçmişini ve transkriptini dallanmadan hemen sonra kullanıma hazır tutun."
    ]
  },
  {
    "version": "0.10.2",
    "date": "2026-08-24",
    "highlights": [
      "Kenar çubuğu daraltıldığında sohbet içeriğini ve oluşturucuyu rahatça ortalanmış halde tutun.",
      "Geçmişin yeniden oynatılması da dahil olmak üzere, dosyanın tamamını belleğe yüklemeden büyük resim ekleri hazırlayın."
    ]
  },
  {
    "version": "0.10.1",
    "date": "2026-08-24",
    "highlights": [
      "Bir çalıştırma etkinken gönderilen kuyruk istemleri ve mevcut taslağı kaybetmeden bunları sırayla teslim eder.",
      "Boşta kalma ve toplam süre zaman aşımlarına sahip arka plan alt aracıları bağlanır ve bir temsilcinin zaman aşımına uğradığını gösterir.",
      "Uzun oturum geçmişlerini sınırlı sayfalara yükleyin ve yukarı kaydırdıkça önceki mesajları alın."
    ]
  },
  {
    "version": "0.10.0",
    "date": "2026-08-21",
    "highlights": [
      "Sağlayıcı başına birden fazla model yapılandırın ve bunlar arasında doğrudan besteciden geçiş yapın.",
      "Aracı yeteneklerini, daha net kapsam blokları ve menülerle yeniden tasarlanan Ayarlar stüdyosunda yönetin.",
      "Yeni bir özellik olarak ana bilgisayar panosu geçmişini eklentilere gösterin.",
      "Boş oturumların kalıcı olmasını sağlayın, böylece yeniden başlatıldıktan sonra gösterilip yeniden kullanılabilirler.",
      "Daha net bir sağlayıcı hiyerarşisi ve istikrarlı kaydırmayla model seçicinin kullanımını kolaylaştırın.",
      "Büyük dosyaların güvenilir şekilde disk belleğine alınabilmesi için Okuma sonuçlarındaki toplam satır sayısını her zaman raporlayın.",
      "Hızı sınırlı akışları yeniden denemelerde daha güvenilir bir şekilde kurtarın.",
      "Seçilen dosyaları Dosyalar panelinden açarken dosya yöneticisinde gösterin."
    ]
  },
  {
    "version": "0.9.1",
    "date": "2026-08-20",
    "highlights": [
      "Kenar çubuğunda tanınmalarını kolaylaştırmak için sabitlenen proje simgelerini belirgin hale getirin.",
      "Alt aracı etkinliğinin, tamamlandıktan sonra Çalışıyor durumunda takılıp kalmasını önleyin.",
      "Eklenti sayfalarını ve panellerini uygulama kromunun geri kalanıyla daha yakın bir şekilde hizalayın.",
      "Bestecide yazmayı ve gönderme gecikmesini azaltın.",
      "Uzun transkriptlerin daha düzgün kaydırılmasını sağlayın ve oturumlar arasında geçiş yaparken flaşın önlenmesini sağlayın.",
      "Boş ana destek çizgisini ve alta hizalanmış besteci düzenini geri yükleyin."
    ]
  },
  {
    "version": "0.9.0",
    "date": "2026-08-20",
    "highlights": [
      "Paketlenmiş Dosyalar panelinde proje dosyalarına göz atın ve bunları işletim sisteminin varsayılan uygulamasıyla açın.",
      "Çalışma paneline eklentinin katkıda bulunduğu yalıtılmış görünümler ekleyin ve pazar yerinin kaynağını ve geri çekilmiş sürüm durumunu görünür tutun.",
      "Bash çıktısını konuşmada ve etkileşimli kabukları harici terminalde tutarken yerleşik etkileşimli terminali kaldırın.",
      "Sağlayıcının hız sınırlarını yinelenen asistan mesajları olmadan yeniden deneyin, ardından yeniden deneme bütçesi tükendiğinde Devam'ı teklif edin.",
      "Model, araç, önbellek ve sıkıştırma kullanımını bir bakışta görmek için kompakt bağlam özetini kullanın.",
      "Bestecideki yerelleştirilmiş eğik çizgi komutu ipuçları aracılığıyla beş temel oturum komutunu öğretin.",
      "Karşılama ve komut ipuçları sorunsuz bir şekilde dönerken, ev ve konuşma oluşturucularını aynı hizada tutun."
    ]
  },
  {
    "version": "0.8.1",
    "date": "2026-08-19",
    "highlights": [
      "Birden fazla satıcı hesabında oturum açın ve her sağlayıcı için kullanılan hesabı seçin.",
      "Resim eklerinin ne zaman destekleneceğine karar vermek için her modelin yeteneklerini kullanın.",
      "Ortaya çıkaran modeller için doğrudan bestecinin akıl yürütme çabasını seçin.",
      "Çakışan oturumları önlemek için veri dizini başına bir PI-Desktop örneğini tutun.",
      "Ayarları daha net gruplar halinde düzenleyin ve sağlayıcı hesap yönetimini basitleştirin.",
      "Yerleşik alt aracıları üst konuşmanın izin moduyla uyumlu tutun."
    ]
  },
  {
    "version": "0.8.0",
    "date": "2026-08-17",
    "highlights": [
      "Arka plan alt aracılarına yetki verin ve konuşmayı engellemeden sonuçlarını bekleyin.",
      "Çalışan alt aracı sınırını 10'a yükseltin ve her aracının izin kapsamını devredilen çalışmaya uygulayın.",
      "Ortak arka plan görevleri için yerleşik gezgin ve düzeltici alt aracıları ekleyin.",
      "Bir kez pencereyi kapatmanın tepsiye küçültülmesi mi yoksa çıkılması mı gerektiğini sorun, ardından seçimi hatırlayın.",
      "Eklenti panellerinin uygulama dilini ve renk modunu takip etmesine izin verin.",
      "Yanıtı durdurmak yerine aynı sırada akış ortası hız sınırı hatalarını yeniden deneyin.",
      "Bir sepet kesintisinden sonra onaylanmış Plan çalıştırmalarını kurtarın.",
      "Sepetli çarpışma bildirimlerinin zaten kapalı olan bir pencereyi kırmasını önleyin."
    ]
  },
  {
    "version": "0.7.0",
    "date": "2026-08-15",
    "highlights": [
      "Eklenti dosyası erişimini her eklentinin beyan edilen dosya kapsamıyla kısıtlayın ve silinen dosyaları kolay kurtarma için çöp kutusuna gönderin.",
      "Her eklentinin bildirilen dosya kapsamını izinlerinin yanında gösterin.",
      "Eklenti ağ isteklerini her eklentinin bildirilen alan adı izin verilenler listesiyle sınırlandırın.",
      "Daha derin entegrasyonların çalışmaya devam etmesi için bilinmeyen eklenti paneli kanallarını eklentiye iletin.",
      "Geçiş yapıldığında kenar çubuğunun daralmasının titremesini önleyin.",
      "Aracı düzenlemelerini satır bağlantılı hale getirin, böylece kesintiye uğrayan düzenleme, dönüşü sessizce bitirmek yerine sorunsuz bir şekilde kurtarılır.",
      "Daha tutarlı bir arayüz için kart tipografi hiyerarşisini uyumlu hale getirin.",
      "Masaüstü kabuğunu ve aracı çalışma zamanını en son Electron ve pi sürümlerine yükseltin."
    ]
  },
  {
    "version": "0.6.0",
    "date": "2026-08-14",
    "highlights": [
      "Belirteç ve önbellek istatistiklerini görmek için tıklandığında içerik kullanım denetçisini açın.",
      "Yeni bir klavye kısayoluyla çalışma paneli görünürlüğünü değiştirin.",
      "İlk mesaj gönderilene kadar yeni görev taslaklarını geçmişin dışında tutun.",
      "Kişiselleştirilmiş tipografi için paketlenmiş OFL yazı tiplerini içeren özel bir genel yazı tipi seçici ekleyin.",
      "Daha hızlı erişim için başlatıcıda yakın zamanda kullanılan eklentileri hatırlayın.",
      "Geliştirici modu için içerik menüsüne oturum yolunu kopyala ekleyin.",
      "Yazı tipi seçici kırpmasını ve Sistem varsayılan sıfırlama sorunlarını düzeltin.",
      "Pencere kapatıldıktan sonra macOS PI-Desktop'u Dock'ta ve Cmd+Sekme'de tutun.",
      "Besteci gönderildikten sonra çöktüğünde sohbet metnini sabit tutun.",
      "Çalışma paneline daha net bir yönlendirmeyle gerçek bir boş durum verin."
    ]
  },
  {
    "version": "0.5.11",
    "date": "2026-08-13",
    "highlights": [
      "Eklenti pazarı için çevrimdışı kullanılabilirlik ve meta veri yenileme ekleyin.",
      "Daha hızlı oturum kurtarma için konuşma başına oluşturucu taslaklarını önbelleğe alın.",
      "Eklenti paneli başlıklarını yerelleştirin ve panel penceresi kromunu uyarlayın.",
      "Koyu yüzeylerdeki maskot anahtar rengini düzeltin.",
      "Daha hızlı etkileşimler için macOS başlatıcısı kısayol gecikmesini azaltın."
    ]
  },
  {
    "version": "0.5.10",
    "date": "2026-08-13",
    "highlights": [
      "Eklenti içeriğinin yerel kontrollerden uzak kalması için eklenti paneli penceresi kromunu ve güvenli alanları hassaslaştırın.",
      "Eklentiler sayfası hiyerarşisini iyileştirin ve daha net bir uzantı iş akışı için genel bakış kopyasını azaltın.",
      "Daha net bir menü çubuğu görünümü için doğru macOS tepsi şablonu simgesini kullanın."
    ]
  },
  {
    "version": "0.5.9",
    "date": "2026-08-13",
    "highlights": [
      "Daha tutarlı bir iş akışı için Hedef modunun otomatik izin işlemeyi kullanmasını sağlayın.",
      "Başka bir uygulamaya odaklanıldığında da dahil olmak üzere daha hızlı açılması için genel eklenti başlatıcıyı önceden ısıtın.",
      "Güvenilir simge durumuna küçültme, büyütme ve kapatma kontrolleriyle eklenti panellerine yerel pencere kromu verin.",
      "İki dilli dokümantasyon sitesini eksiksiz İngilizce ve Basitleştirilmiş Çince kılavuzlar ve spesifikasyonlarla yenileyin."
    ]
  },
  {
    "version": "0.5.8",
    "date": "2026-08-12",
    "highlights": [
      "Başka bir uygulamaya odaklanıldığında Windows Alt+Space genel eklenti başlatıcısını geri yükleyin.",
      "MacOS, Windows ve Linux'ta simge durumuna küçültüldüğünde PI-Desktop'un sistem tepsisinde kullanılabilir olmasını sağlayın.",
      "Açık ve koyu temalarda yerel seçim menüsünün okunabilirliğini iyileştirin."
    ]
  },
  {
    "version": "0.5.7",
    "date": "2026-08-12",
    "highlights": [
      "Tek seçimli, çoklu seçimli, özel yanıtlar, atlama ve reddetme akışlarıyla asktool soruları ekleyin.",
      "Yanıtlanmış, yanıtlanmamış ve atlanmış göstergelerle çoklu soru ilerlemesini görünür tutun.",
      "Etkileşimli soruları Plan ve Hedef onaylarıyla aynı oluşturucu onay yüzeyine yerleştirin.",
      "Onay kartlarını basitleştirin ve bir sonraki istek için seçilen onay modunu hatırlayın."
    ]
  },
  {
    "version": "0.5.6",
    "date": "2026-08-11",
    "highlights": [
      "Kurulu eklentileri mevcut çalışma alanından ayrılmadan genel klavye başlatıcısından açın.",
      "Uzun konuşmaların okunabilir kalmasını sağlamak için genişletilmiş düşünme, araç ve alt aracı ayrıntılarını daraltın.",
      "Görev yapılandırmasını etkin dönüşler sırasında kullanılabilir durumda tutun ve durduktan sonra üretim istatistiklerini gösterin.",
      "Daha net görsel gruplama için arayüz genelinde köşe hiyerarşisini hassaslaştırın."
    ]
  },
  {
    "version": "0.5.5",
    "date": "2026-08-11",
    "highlights": [
      "Paralel alt aracıları ve bunların görev ilişkilerini doğrudan konuşmada görselleştirin.",
      "Yapıştırılan dosya referanslarını kompakt tutun ve bir dönüşü durdurduktan sonra çiplerini geri yükleyin.",
      "Oturum oluşturma sırasında mod kontrollerini kullanılabilir durumda tutun ve transkript gönderildikten sonra sabitlendi.",
      "Yerel araçlar yanlış bir dosya yolu aldığında daha sorunsuz bir şekilde kurtarma yapın.",
      "Kenar çubuğu altbilgisi eylemleri ve kullanıcı mesajlarındaki sarılmış bağlantılar iyileştirildi."
    ]
  },
  {
    "version": "0.5.4",
    "date": "2026-08-08",
    "highlights": [
      "Boş ev maskotunu daha yavaş boşta poz değişiklikleri ve fareyle üzerine gelindiğinde sürekli oynatmayla iyileştirin."
    ]
  },
  {
    "version": "0.5.0",
    "date": "2026-08-07",
    "highlights": [
      "Kullanıcı tanımlı aracılar, sabitlenmiş modeller, ilişkilendirme ve oturum kalıcılığı ile bir Görev aracının arkasında sınırlı alt aracıları çalıştırın.",
      "Kayıt defteri yeniden yüklemeleri ve daha net salt okunur durumuyla Uzantılardaki alt aracıları yönetin.",
      "Boşta kalma süresi sırasında, transkript geçmişini koruyarak ve sıkıştırma satırları ile uyarıları göstererek bağlam denetim noktaları hazırlayın ve yükleyin.",
      "İkinci sözleşme modu olarak Hedef modunu ekleyin ve mod komutları aracılığıyla yapıştırılan dosya referanslarını koruyun.",
      "Ana bilgisayar yeniden bağlandığında, daha sessiz rutin sökme tanılamalarıyla alt aracıyı ve ana bilgisayar destekli panelleri geri yükleyin.",
      "Çalışma panelini ve uzantı yüzeylerini daha net meta veriler, kontroller ve koyu tema kontrastıyla güzelleştirin."
    ]
  },
  {
    "version": "0.4.3",
    "date": "2026-08-05",
    "highlights": [
      "Yalnızca Aracılara Özel Plan iş akışını dayanıklı Markdown kontrol noktaları, onay ve sıraya alınmış yürütme ile tamamlayın.",
      "Tek bir Uzantı kapsam kontrolüyle proje kapsamlı MCP sunucuları ve Beceriler ekleyin.",
      "Çalışma alanlarında harici yol izinlerini ve yerel arama kapsamını güçlendirin.",
      "Çözüm ve mod komutları etkin oturumu değiştirdikten sonra Plan onay yüzeylerinin kapatılmasını sağlayın.",
      "Uzun konuşmalar otomatik olarak sıkıştırılır: transkript her mesajı saklar, her sıkıştırmanın nerede gerçekleştiğini işaretler ve yeni bir oturum başlatıp başlatmayacağınıza karar verebilmeniz için sizi uyarır."
    ]
  },
  {
    "version": "0.4.2",
    "date": "2026-08-03",
    "highlights": [
      "Daha iyi şeffaflık için sohbet metni başlığında bağlam önbelleği isabet oranını göster."
    ]
  },
  {
    "version": "0.4.1",
    "date": "2026-08-02",
    "highlights": [
      "GitHub Sürümlerini güncelleyin ve standart PI-Desktop deposuna olan bağlantıları otomatik olarak güncelleyin.",
      "PI-Desktop veri havuzu adını kullanmak için projeyi, eklentiyi ve sürüm belgelerini yenileyin."
    ]
  },
  {
    "version": "0.4.0",
    "date": "2026-08-01",
    "highlights": [
      "Eklentiler artık becerilere, temalara, MCP sunucularına, yerleşik hizmetlere ve eklentiler arası mesaj veriyoluna katkıda bulunabilir.",
      "Eklenti SDK'sı tüm yeni yetenek türlerini bildirir, böylece yazarlar bunları bildirimden etkinleştirebilir.",
      "Ana bilgisayar çekirdeği, yetenek katkılarını doğrular ve eklenti başına izinleri otomatik olarak türetir.",
      "Aracı sistemi istemi artık araca duyarlı konuşmalar için eklenti tarafından bildirilen becerileri içeriyor.",
      "Eklentiler sayfası, şablon seçici, kaydetme sırasında çalışırken yeniden yükleme ve yazma araçlarıyla yeniden tasarlandı.",
      "Bir şablondan eklenti oluşturmak artık iskele klasörünü proje olarak açıyor.",
      "Daha temiz kontroller ve bağlam eylemleri içeren birleşik çalışma paneli başlık menüsü.",
      "Stiller yüzey başına kısmi parçalara bölünmüştür; yinelenen ve ölü CSS kaldırıldı."
    ]
  },
  {
    "version": "0.3.0",
    "date": "2026-07-31",
    "highlights": [
      "Ayarlar proje arşivi artık bölüm başına sayımlar, canlı arama ve sıralama kontrolleri ile gruplandırılmış bölümleri (Sabitlenmiş / Tümü / Arşivlenmiş) gösteriyor.",
      "Çalışma paneli yerleştirme alanı genişliği, daha iyi yerleşim oranları için daha dardır.",
      "Açık temadaki geçiş stilini düzeltin."
    ]
  },
  {
    "version": "0.2.11",
    "date": "2026-07-31",
    "highlights": [
      "Genel Arama artık sohbetleri, sayfaları, Ayarları ve yerleşik veya eklenti komutlarını tek bir yerde buluyor.",
      "Görünüm kontrolleri artık tema ve dil önizleme kartlarını kullanıyor; otomatik dil, işletim sistemi yerel ayarını doğru şekilde takip ediyor.",
      "Ayarlar artık daha net gezinme için özel Yapay Zeka ve Kısayollar bölümlerine sahip.",
      "Aracı artık katmanlı AGENTS.md/CLAUDE.md proje talimatlarını global ve proje AGENTS.md düzenleyicileriyle birlikte yüklüyor.",
      "Proje arşivi artık oturum başlıklarını arıyor ve en yeni etkinlikleri, oturum sayılarını, zaman damgalarını ve genişletilebilir geçmişi gösteriyor.",
      "Korumalı alana alınmış önyükleme gerilemesinin neden olduğu masaüstü başlatma hatasını düzeltin.",
      "Çevrimdışı sözdizimi vurgulamayı ve yerel terminal desteğini korurken denetlenen macOS paketlenmemiş uygulama alanını yaklaşık %55 azaltın."
    ]
  },
  {
    "version": "0.2.10",
    "date": "2026-07-30",
    "highlights": [
      "Geliştirilmiş kontrollere sahip Codex/WorkBuddy tarzı konuşma üst çubuğu ekleyin.",
      "Daha iyi okunabilirlik için sohbet metnini ve işaretlemeli düzyazı stilini yenileyin.",
      "Çalışma paneli başlığını içerik menüsüyle birleştirin ve kenar çubuğu daraltmayı canlandırın.",
      "Daha temiz bir arayüz için araç başlatıcılarını tek bir açılır menüde birleştirin.",
      "Çalışma panelini genişletmek yerine sabit pencerenin içine yerleştirin.",
      "Üst çubuk kontrollerini cilalayın: yinelenenleri kaldırma geçişi, kontrolleri koruma, macOS hizalaması."
    ]
  },
  {
    "version": "0.2.8",
    "date": "2026-07-29",
    "highlights": [
      "Güncelleme istemleri ve Ayarlar artık yerelleştirilmiş sürüm notlarının tamamını açıyor.",
      "Çalışma paneli genişletme ve daraltma animasyonları daha akıcı görünüyor.",
      "Uzun konuşmalar, büyük boyutlu araç-sonuç gruplarını daha güvenilir şekilde sıkıştırır."
    ]
  },
  {
    "version": "0.2.7",
    "date": "2026-07-28",
    "highlights": [
      "İşaretleme yanıtları görüntüleri, sesleri ve videoları satır içi olarak işleyebilir.",
      "Uzak görüntüler güncellenmiş içerik güvenliği ilkesiyle görüntülenir.",
      "Medya işaretlemesi temizlendi, böylece yalnızca güvenli etiketlere izin verildi."
    ]
  },
  {
    "version": "0.2.6",
    "date": "2026-07-28",
    "highlights": [
      "Dönüş sınırı bağlamı kontrol noktaları, geçmişi gizlemeden uzun sohbetleri sıkıştırır.",
      "Önbelleğe alınmış transkriptler ve kararlı bir çerçeveyle daha sorunsuz konuşma geçişi.",
      "Yerleşik araçlar sabit genişliği korur, böylece sohbet çalışma panelinin yanında okunabilir kalır.",
      "Proje menüsü, sistem dosya yöneticinizdeki klasörü açabilir.",
      "Besteci bilgi istemi satırları artık önde gelen marka simgesini göstermiyor."
    ]
  },
  {
    "version": "0.2.5",
    "date": "2026-07-28",
    "highlights": [
      "Çalışma paneli gezinmesi, daha net bir araç rayıyla yeniden tasarlandı.",
      "Pencere yeniden boyutlandırma panel uyumlu olduğundan düzen tahmin edilebilir kalır.",
      "Akış oluşturma işlemleri daha hızlı etkileşim için yalıtılmıştır.",
      "Yeni akıl yürütme oturumları mümkün olduğunda varsayılan olarak maksimum düşünmeyi kullanır.",
      "Konuşma metni siz gönderdikten sonra en son iletiye sabitlenmiş halde kalır."
    ]
  },
  {
    "version": "0.2.4",
    "date": "2026-07-28",
    "highlights": [
      "Besteci çipleri, alt öğelerin tamamen görünür olmasını sağlar.",
      "Opus 5 desteği dahil daha yeni Claude modelleri için pi-ai güncellendi."
    ]
  },
  {
    "version": "0.2.3",
    "date": "2026-07-28",
    "highlights": [
      "Kabuk kopyası yerel ayarlarda sade kullanıcı dilinde yeniden yazıldı.",
      "Seçim, CJK etiketleri ve fareyle üzerine gelme hareketi cilalama.",
      "Çalışma paneli ve Ayarlar ışık yüzeyleri iyileştirildi.",
      "Ön sürüm yüklemeleri artık daha yeni kararlı GitHub sürümlerini keşfediyor."
    ]
  },
  {
    "version": "0.2.2",
    "date": "2026-07-27",
    "highlights": [
      "Resmi uzaktan katalog ve ayrıntı bölmeleri içeren eklenti pazarı.",
      "Yalıtılmış eklenti panelleri ve geçitli yüksek riskli API'ler.",
      "Projeler veya oturumlar oluşturmak için bölüm araç çubuklarına sağ tıklayın.",
      "Başlangıç ​​ekranı, daha yumuşak hareket ve i18n cilası.",
      "Çalışma paneli üst gezintisi, araçları açmak için sağ tıklamayı destekler."
    ]
  },
  {
    "version": "0.2.1",
    "date": "2026-07-27",
    "highlights": [
      "Çalışma paneli araçları görüşme başına korunur.",
      "İnceleme girişi, düzenlemeleri yapan oturumun kapsamına alınır."
    ]
  },
  {
    "version": "0.2.0",
    "date": "2026-07-27",
    "highlights": [
      "Kenar çubuğu, projeleri ve oturumları daha net görev durumuyla ayırır.",
      "Asistan yanıtlarını çatallayın veya düzenleyin; yalnızca simge içeren mesaj araç çubukları.",
      "Başarılı dosya düzenlemelerinden sonra çalışma alanı inceleme girişi.",
      "DevTools için klavye kısayol eşlemeleri ve geliştirici modu.",
      "pi model kataloğu, sağlayıcı modellerinin otoritesidir.",
      "Düşünme kontrolü, bestecideki modun yanında bulunur."
    ]
  },
  {
    "version": "0.1.1",
    "date": "2026-07-26",
    "highlights": [
      "İlk genel yayın: yerel öncelikli AI kodlama aracısı masaüstü istemcisi.",
      "Akış, düşünme düzeyleri ve model yönetimi içeren Sohbet ve Temsilci modları.",
      "İzin geçişi, terminal, tarayıcı ve git incelemesi içeren çalışma alanı araçları.",
      "Depolama, gizli diziler, oturumlar ve bildirimler için Rust ana bilgisayar çekirdeği.",
      "Eklenti temeli artı çift İngilizce / 简体中文 kullanıcı arayüzü.",
      "GitHub Sürümlerine göre güncelleme kontrolleri (desteklendiği yerlerde uygulama içi)."
    ]
  }
];
