# Linux上でAMD GPUを使用したボイスチェンジャー

## はじめに

現在、Windowsでは AMD GPU を使用した機械学習ソリューションの利用にはドライバーサポートの不足という大きな課題があります。AMD は新しい GPU 向けに ROCm をリリースしていますが、Windows 向けの MIOpen はまだリリースされていません。MIOpen がなければ PyTorch のリリースもありません。DirectML は現在唯一のハードウェア非依存のソリューションですが、パフォーマンスが低く、インデックスを読み込めない ONNX モデルが必要です。

幸いなことに、AMD は Linux 上で優れたドライバーサポートを提供しており、ROCm を使用することでボイスチェンジャーの CUDA 実装を活用でき、大幅なパフォーマンス向上が得られます。インデックスファイルを含む標準的なモデルを使用できるようになります。Linux はゲーミングとは結びつきにくいイメージがありますが、[Steam Proton](https://www.protondb.com/)、[Lutris](https://lutris.net/)、[Wine](https://www.winehq.org/) などのツールを使えば Linux 上でほとんどのゲームをプレイできます。

**Radeon RX 7900 XTX でのベンチマーク:**
- DirectML: Chunk 112, Extra 8192 (rmvpe_onnx 使用)
- CUDA: Chunk 48, Extra 131072 (rvmpe 使用)

## 前提条件

### AMDGPU ドライバーと ROCm

まず、お使いのシステムに適切なドライバーをインストールする必要があります。多くのディストリビューションでは、パッケージマネージャーを通じて簡単にドライバーをインストールできます。あるいは、[AMD ウェブサイト](https://www.amd.com/en/support)からドライバーを直接ダウンロードすることもできます。「Graphics」を選択し、お使いの GPU を選んで、ディストリビューションに対応したバージョンをダウンロードしてください。その後、ダウンロードしたファイルを参照してパッケージマネージャーでドライバーを直接インストールします。

次に、[AMD の公式ガイド](https://rocm.docs.amd.com/en/latest/deploy/linux/index.html)に従って ROCm をインストールします。[パッケージマネージャー](https://rocm.docs.amd.com/en/latest/deploy/linux/os-native/install.html)を使用するか、[AMDGPU インストールスクリプト](https://rocm.docs.amd.com/en/latest/deploy/linux/installer/index.html)を使用してパッケージをインストールできます。

### Anaconda (任意)

2 つ目の依存関係は任意ですが推奨されます。Anaconda は Python パッケージと環境を管理するために使用でき、同じライブラリを使用する複数のソフトウェア間の依存関係の競合を防ぐことができます。多くのディストリビューションでは、[パッケージマネージャー](https://docs.anaconda.com/free/anaconda/install/linux/)を通じて Anaconda をインストールできます。あるいは、[Anaconda ウェブサイト](https://www.anaconda.com/download)からパッケージをダウンロードして、手動でインストーラーを実行することもできます:

```bash
cd ~/Downloads
chmod u+x Anaconda3-xxx-Linux-x86_64.sh
./Anaconda3-xxx-Linux-x86_64.sh
```

## 環境のセットアップ

新しい環境を作成し、ボイスチェンジャーをダウンロードして、依存関係をセットアップします。まず conda を使用して新しい環境を作成し、Python のバージョンを指定します。Python 3.10.9 は ROCm 7.2 と相性が良いです。他のバージョンについては PyTorch のドキュメントを確認してください:

```bash
conda create --name voicechanger python=3.10.9
```

環境をアクティブにして、その中に依存関係をインストールします:

```bash
conda activate voicechanger
```

次に新しいディレクトリを作成し、Github リポジトリをクローンします。この方法を使用すれば HuggingFace からリリースをダウンロードする必要はありません。

```bash
mkdir ~/Documents/voicechanger
cd ~/Documents/voicechanger
git clone https://github.com/w-okada/voice-changer.git
```

## 依存関係のインストール

リポジトリをダウンロードした後、すべての依存関係をインストールします。まず ROCm 用の PyTorch から始めます。AMD は正しい PyTorch バージョンをインストールするための[ガイド](https://rocm.docs.amd.com/projects/radeon/en/latest/docs/install/install-pytorch.html)を提供しており、定期的に更新されています。conda 環境の作成時に他の手順は自動的に処理されるため、まず Torch と Torchvision をダウンロードします:

```bash
# Wheels のバージョンは GPU と現在の ROCm リリースによって異なる場合があります
wget https://repo.radeon.com/rocm/manylinux/rocm-rel-5.7/torch-2.0.1%2Brocm5.7-cp310-cp310-linux_x86_64.whl
wget https://repo.radeon.com/rocm/manylinux/rocm-rel-5.7/torchvision-0.15.2%2Brocm5.7-cp310-cp310-linux_x86_64.whl
```

ディレクトリは次のようになっているはずです:

```bash
$ ls
torch-2.0.1+rocm5.7-cp310-cp310-linux_x86_64.whl
torchvision-0.15.2+rocm5.7-cp310-cp310-linux_x86_64.whl
voice-changer
```

次に、環境内に PyTorch をインストールします:

```bash
pip3 install --force-reinstall torch-2.0.1+rocm5.7-cp310-cp310-linux_x86_64.whl torchvision-0.15.2+rocm5.7-cp310-cp310-linux_x86_64.whl
```

ボイスチェンジャーを実行するために、pip を使用して追加の依存関係をインストールします。server ディレクトリに移動して、pip で requirements.txt ファイルをインストールします:

```bash
cd ~/Documents/voicechanger/voice-changer/server
pip install -r requirements.txt
```

## サーバーの起動

依存関係をインストールしたら、MMVCServerSIO.py ファイルを使用してサーバーを起動します:

```bash
python3 MMVCServerSIO.py
```

サーバーが必要なすべてのモデルをダウンロードして起動します。http://127.0.0.1:18888/ を開くことで WebUI からボイスチェンジャーを使用できます。メニューから GPU を選択できます。

![image](images/amd_gpu_select.png)

## オーディオループバックの設定

最後のステップとして、Web UI の出力をアプリケーションでマイクとして使用できる入力にリダイレクトする仮想オーディオデバイスを作成します。

ほとんどのディストリビューションはデフォルトで PulseAudio を使用しており、2 つの仮想デバイスを作成することでオーディオループバックを作成できます。仮想オーディオデバイスの設定については[ガイド](https://github.com/NapoleonWils0n/cerberus/blob/master/pulseaudio/virtual-mic.org)があります。ドキュメントの先頭には一時的なセットアップの方法があります。default.pa 設定を作成することで永続的なデバイスを作成できます。

オーディオデバイスのデフォルト名は次のとおりです:
- 入力: Virtual Source VirtualMic on Monitor of NullOutput
- 出力: Null Output

ほとんどのアプリケーションでは、オーディオデバイスを入力として選択できます。Wine や Lutris を使用していてそれらの環境内でマイクを使用したい場合は、Wine の設定にデバイスを追加する必要があります。

![image](images/wine_device.png)
